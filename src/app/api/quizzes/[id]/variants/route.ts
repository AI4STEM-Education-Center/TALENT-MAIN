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
  return quiz && canManage(actor, quiz) ? quiz : null;
}
export async function GET(_req: NextRequest, context: Context) {
  const quiz = await ownedQuiz(context);
  if (!quiz)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  const versions = await prisma.quizPracticeVersion.findMany({
    where: { quizId: quiz.id },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  return NextResponse.json({
    versions: versions.map((v) => ({
      ...v,
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
  const versions = await prisma.$transaction(async (tx) => {
    if (
      await tx.quizPracticeVersion.count({
        where: { quizId: quiz.id, status: { in: ["QUEUED", "GENERATING"] } },
      })
    )
      return null;
    const modes = body.data.bothModes
      ? ["NUMBERS", "CONTEXT"]
      : [body.data.variation];
    const created = [];
    for (const variation of modes) {
      for (let i = 0; i < body.data.count; i++) {
        created.push(
          await tx.quizPracticeVersion.create({
            data: {
              quizId: quiz.id,
              name:
                body.data.count === 1
                  ? body.data.name
                  : `${body.data.name.slice(0, 80)} · ${variation === "NUMBERS" ? "Numbers" : "Context"} ${i + 1}`,
              variation,
              objectives: JSON.stringify(objectives),
              sourceSnapshot: JSON.stringify(sources),
            },
          }),
        );
      }
    }
    return created;
  });
  if (!versions)
    return NextResponse.json(
      { error: "A version is already generating for this quiz." },
      { status: 409 },
    );
  const results = await Promise.all(
    versions.map((version) => queueVersion(version.id)),
  );
  const failed = results.find((result) => !result.ok);
  if (failed) return failed;
  return NextResponse.json(
    { id: versions[0].id, ids: versions.map((v) => v.id), status: "QUEUED" },
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
  action: z.enum(["publish", "retire", "retry", "edit"]),
  questions: z.unknown().optional(),
});
export async function PATCH(req: NextRequest, context: Context) {
  const quiz = await ownedQuiz(context);
  if (!quiz)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  const body = changeSchema.safeParse(await req.json().catch(() => null));
  if (!body.success)
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
  const expected =
    action === "publish" || action === "edit"
      ? "REVIEW"
      : action === "retire"
        ? "PUBLISHED"
        : "FAILED";
  if (
    version.status !== expected &&
    !(
      action === "edit" &&
      version.status === "FAILED" &&
      version.questions !== "[]"
    )
  )
    return NextResponse.json(
      { error: "Version changed. Reload before continuing." },
      { status: 409 },
    );
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
        : "QUEUED";
  const changed = await prisma.quizPracticeVersion.updateMany({
    where: {
      id: versionId,
      status: version.status,
      updatedAt: version.updatedAt,
    },
    data: {
      status,
      error: null,
      ...(questions
        ? { questions: JSON.stringify(questions), validation: null }
        : {}),
      ...(action === "retry" ? { validation: null } : {}),
    },
  });
  if (!changed.count)
    return NextResponse.json(
      { error: "Version changed. Reload before continuing." },
      { status: 409 },
    );
  if (status === "QUEUED") return queueVersion(versionId);
  return NextResponse.json({ id: versionId, status });
}
