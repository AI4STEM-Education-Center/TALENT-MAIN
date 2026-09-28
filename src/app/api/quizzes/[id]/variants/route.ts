import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { enqueueQuizVariant } from "@/lib/queue";
import {
  objectiveSchema,
  validateVariant,
  type VariantQuestion,
} from "@/lib/quiz-variants";
import { QUESTION_ORDER } from "@/lib/question-order";
import { createStandaloneQuiz } from "@/lib/quiz-variant-standalone";

/** Drafts generating at once per quiz; bounds provider bursts and cost. */
const MAX_IN_FLIGHT = 8;

type Context = { params: Promise<{ id: string }> };
async function ownedQuiz(context: Context) {
  const [actor, { id }] = await Promise.all([
    getContentActor(),
    context.params,
  ]);
  if (!actor) return null;
  const quiz = await prisma.quiz.findUnique({
    where: { id },
    include: {
      questions: { include: { options: true }, orderBy: QUESTION_ORDER },
    },
  });
  return quiz && canManage(actor, quiz) ? Object.assign(quiz, { actor }) : null;
}
export async function GET(_req: NextRequest, context: Context) {
  const quiz = await ownedQuiz(context);
  if (!quiz)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  const versions = await prisma.quizPracticeVersion.findMany({
    where: { quizId: quiz.id, status: { not: "DISCARDED" } },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  // A standalone exam may since have been deleted; only link live ones.
  const standalone = await prisma.quiz.findMany({
    where: {
      id: {
        in: versions.flatMap((v) =>
          v.standaloneQuizId ? [v.standaloneQuizId] : [],
        ),
      },
    },
    select: { id: true, name: true },
  });
  const standaloneById = new Map(standalone.map((q) => [q.id, q]));
  return NextResponse.json({
    versions: versions.map((v) => ({
      ...v,
      standaloneQuiz: v.standaloneQuizId
        ? (standaloneById.get(v.standaloneQuizId) ?? null)
        : null,
      questions: JSON.parse(v.questions),
      sourceSnapshot: JSON.parse(v.sourceSnapshot),
      objectives: JSON.parse(v.objectives),
      validation: v.validation ? JSON.parse(v.validation) : null,
    })),
  });
}
const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  variation: z.enum(["NUMBERS", "CONTEXT"]),
  objectives: objectiveSchema,
  count: z.number().int().min(1).max(4).default(1),
  bothModes: z.boolean().default(false),
  purpose: z.enum(["ALTERNATE", "STANDALONE"]).default("ALTERNATE"),
  // Append to an existing round ("Generate two more") instead of starting one.
  batchId: z.string().min(1).max(100).optional(),
});
export async function POST(req: NextRequest, context: Context) {
  const quiz = await ownedQuiz(context);
  if (!quiz)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  const body = createSchema.safeParse(await req.json().catch(() => null));
  if (!body.success)
    return NextResponse.json(
      {
        error:
          "Provide a name, variation, and an objective (at least 10 characters) for every question.",
      },
      { status: 400 },
    );
  if (
    !quiz.questions.length ||
    quiz.questions.length > 40 ||
    quiz.questions.some(
      (q) =>
        !["SINGLE_SELECT", "NUMERIC"].includes(q.answerMode) ||
        q.figureStorageKey ||
        q.options.some((o) => o.imageStorageKey),
    )
  )
    return NextResponse.json(
      {
        error:
          "Practice generation currently supports 1–40 text-only single-select or numeric questions. Remove image-dependent and multi-select questions from this quiz first.",
      },
      { status: 400 },
    );
  const objectives = body.data.objectives;
  if (
    objectives.length !== quiz.questions.length ||
    new Set(objectives.map((o) => o.sourceQuestionId)).size !==
      quiz.questions.length ||
    objectives.some(
      (o) => !quiz.questions.some((q) => q.id === o.sourceQuestionId),
    )
  )
    return NextResponse.json(
      {
        error:
          "Objectives must match every current source question exactly once. Reload after editing the quiz.",
      },
      { status: 400 },
    );
  const objectiveById = new Map(
    objectives.map((o) => [o.sourceQuestionId, o.objective]),
  );
  // Store only assessment content: student data is never sent to generation.
  const sources = quiz.questions.map((q) => ({
    id: q.id,
    sourceQuestionId: q.id,
    text: q.text,
    answerMode: q.answerMode,
    answerUnit: q.answerUnit,
    answerNumeric: q.answerNumeric,
    answerTolerance: q.answerTolerance,
    options: q.options.map((o) => ({
      id: o.id,
      text: o.text,
      isCorrect: o.isCorrect,
    })),
    solution: q.feedbackGeneral || "Source answer key",
    intentExplanation: objectiveById.get(q.id) ?? "",
  }));
  try {
    validateVariant({ questions: sources }, sources);
  } catch {
    return NextResponse.json(
      {
        error:
          "Fix missing or invalid source answer keys before generating alternatives.",
      },
      { status: 400 },
    );
  }
  const modes = body.data.bothModes
    ? ["NUMBERS", "CONTEXT"]
    : [body.data.variation];
  const requested = modes.length * body.data.count;
  const outcome = await prisma.$transaction(async (tx) => {
    const inFlight = await tx.quizPracticeVersion.count({
      where: { quizId: quiz.id, status: { in: ["QUEUED", "GENERATING"] } },
    });
    let batchId = body.data.batchId;
    let purpose = body.data.purpose;
    const batch = batchId
      ? await tx.quizPracticeVersion.findMany({
          where: { quizId: quiz.id, batchId },
          select: { variation: true, purpose: true },
        })
      : [];
    if (batchId) {
      if (!batch.length) return "missing" as const;
      if (inFlight + requested > MAX_IN_FLIGHT) return "busy" as const;
      purpose = batch[0].purpose as typeof purpose;
    } else {
      if (inFlight) return "busy" as const;
      batchId = crypto.randomUUID();
    }
    const created = [];
    for (const variation of modes) {
      const offset = batch.filter((v) => v.variation === variation).length;
      for (let i = 0; i < body.data.count; i++) {
        created.push(
          await tx.quizPracticeVersion.create({
            data: {
              quizId: quiz.id,
              name:
                body.data.count === 1 && !body.data.bothModes && !offset
                  ? body.data.name
                  : `${body.data.name.slice(0, 80)} · ${variation === "NUMBERS" ? "Numbers" : "Context"} ${offset + i + 1}`,
              variation,
              batchId,
              purpose,
              objectives: JSON.stringify(objectives),
              sourceSnapshot: JSON.stringify(sources),
            },
          }),
        );
      }
    }
    return created;
  });
  if (outcome === "missing")
    return NextResponse.json(
      { error: "That generation round no longer exists. Start a new one." },
      { status: 404 },
    );
  const versions = outcome === "busy" ? null : outcome;
  if (!versions)
    return NextResponse.json(
      {
        error: body.data.batchId
          ? "Too many versions are generating. Wait for some to finish."
          : "A version is already generating for this quiz.",
      },
      { status: 409 },
    );
  const results = await Promise.all(
    versions.map((version) => queueVersion(version.id)),
  );
  const failed = results.find((result) => !result.ok);
  if (failed) return failed;
  return NextResponse.json(
    {
      id: versions[0].id,
      ids: versions.map((v) => v.id),
      batchId: versions[0].batchId,
      status: "QUEUED",
    },
    { status: 202 },
  );
}

async function queueVersion(id: string) {
  try {
    enqueueQuizVariant(id);
  } catch {
    await prisma.quizPracticeVersion.update({
      where: { id },
      data: {
        status: "FAILED",
        error: "Could not queue generation. Retry this version.",
      },
    });
    return NextResponse.json(
      { error: "Could not queue generation. Retry this version." },
      { status: 503 },
    );
  }
  return NextResponse.json({ id, status: "QUEUED" }, { status: 202 });
}
const changeSchema = z.object({
  versionId: z.string(),
  action: z.enum([
    "publish",
    "retire",
    "retry",
    "edit",
    "discard",
    "revise",
    "standalone",
  ]),
  questions: z.unknown().optional(),
  feedback: z.string().trim().min(1).max(2000).optional(),
});
// Which statuses each action may start from.
const FROM: Record<z.infer<typeof changeSchema>["action"], string[]> = {
  publish: ["REVIEW"],
  standalone: ["REVIEW"],
  edit: ["REVIEW", "FAILED"],
  retire: ["PUBLISHED"],
  retry: ["FAILED"],
  discard: ["REVIEW", "FAILED"],
  revise: ["REVIEW", "FAILED"],
};
const conflict = () =>
  NextResponse.json(
    { error: "Version changed. Reload before continuing." },
    { status: 409 },
  );
export async function PATCH(req: NextRequest, context: Context) {
  const quiz = await ownedQuiz(context);
  if (!quiz)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  const body = changeSchema.safeParse(await req.json().catch(() => null));
  if (!body.success || (body.data.action === "revise" && !body.data.feedback))
    return NextResponse.json(
      { error: "Invalid version action" },
      { status: 400 },
    );
  const { versionId, action } = body.data;
  const version = await prisma.quizPracticeVersion.findFirst({
    where: { id: versionId, quizId: quiz.id },
  });
  if (!version)
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  if (
    !FROM[action].includes(version.status) ||
    (action === "edit" &&
      version.status === "FAILED" &&
      version.questions === "[]")
  )
    return conflict();
  const fence = {
    id: versionId,
    status: version.status,
    updatedAt: version.updatedAt,
  };
  if (action === "revise") {
    const revision = await prisma.$transaction(async (tx) => {
      const discarded = await tx.quizPracticeVersion.updateMany({
        where: fence,
        data: { status: "DISCARDED" },
      });
      if (!discarded.count) return null;
      return tx.quizPracticeVersion.create({
        data: {
          quizId: quiz.id,
          name: version.name,
          variation: version.variation,
          batchId: version.batchId,
          purpose: version.purpose,
          objectives: version.objectives,
          sourceSnapshot: version.sourceSnapshot,
          feedback: body.data.feedback,
          revisedFromId: version.id,
        },
      });
    });
    return revision ? queueVersion(revision.id) : conflict();
  }
  if (action === "standalone") {
    const created = await prisma.$transaction(async (tx) => {
      const claimed = await tx.quizPracticeVersion.updateMany({
        where: fence,
        data: { status: "STANDALONE" },
      });
      if (!claimed.count) return null;
      const saved = await tx.quizPracticeVersion.count({
        where: { quizId: quiz.id, status: "STANDALONE" },
      });
      const standalone = await createStandaloneQuiz(
        tx,
        quiz,
        JSON.parse(version.questions),
        `${quiz.name} (new version ${saved})`,
        quiz.actor.teacherId,
      );
      await tx.quizPracticeVersion.update({
        where: { id: versionId },
        data: { standaloneQuizId: standalone.id },
      });
      return standalone;
    });
    if (!created) return conflict();
    return NextResponse.json({
      id: versionId,
      status: "STANDALONE",
      quizId: created.id,
      quizName: created.name,
    });
  }
  let questions: VariantQuestion[] | undefined;
  if (action === "edit") {
    try {
      questions = validateVariant(
        { questions: body.data.questions },
        JSON.parse(version.sourceSnapshot),
      );
    } catch {
      return NextResponse.json(
        { error: "Invalid edited questions or answer keys." },
        { status: 400 },
      );
    }
  }
  const status =
    action === "publish"
      ? "PUBLISHED"
      : action === "retire"
        ? "RETIRED"
        : action === "discard"
          ? "DISCARDED"
          : "QUEUED";
  const changed = await prisma.quizPracticeVersion.updateMany({
    where: fence,
    data: {
      status,
      error: null,
      ...(questions
        ? {
            questions: JSON.stringify(questions),
            validation: null,
            teacherEdited: true,
          }
        : {}),
      // A fresh retry regenerates from scratch; a teacher edit is re-verified.
      ...(action === "retry"
        ? {
            validation: null,
            ...(version.teacherEdited ? {} : { questions: "[]" }),
          }
        : {}),
    },
  });
  if (!changed.count) return conflict();
  if (status === "QUEUED") return queueVersion(versionId);
  return NextResponse.json({ id: versionId, status });
}
