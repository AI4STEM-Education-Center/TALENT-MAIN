import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { enqueueQuizVariant } from "@/lib/queue";
import {
  MIX_COUNTS,
  objectiveSchema,
  questionRevisionListSchema,
  validateVariant,
  validateVerification,
  variantMixSchema,
  variantQuestionSchema,
  verificationSchema,
  type QuestionRevision,
  type VariantQuestion,
} from "@/lib/quiz-variants";
import { createStandaloneQuiz } from "@/lib/quiz-variant-standalone";
import { appOrigin } from "@/lib/app-url";
import { recordVariantBatchState } from "@/lib/quiz-variant-notifications";
import {
  INVALID_KEYS_ERROR,
  managedVariantQuiz,
  questionsStillMatchQuiz,
  snapshotMatchesQuiz,
  sourceFromQuestion,
  sourcesHaveValidKeys,
  variantSupportError,
  type ManagedVariantQuiz,
  type VariantRouteContext,
} from "@/lib/quiz-variant-sources";

/** Drafts generating at once per quiz; bounds provider bursts and cost. */
const MAX_IN_FLIGHT = 8;

type Context = VariantRouteContext;
type Variation = "NUMBERS" | "CONTEXT";

const recipientRole = (quiz: ManagedVariantQuiz) =>
  quiz.actor.role === "ADMIN" ? ("ADMIN" as const) : ("TEACHER" as const);
const safeAppOrigin = (req: NextRequest) => {
  try {
    return appOrigin(req);
  } catch {
    return null;
  }
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function GET(req: NextRequest, context: Context) {
  const quiz = await managedVariantQuiz(context);
  if (!quiz)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  const batchId = req.nextUrl.searchParams.get("batchId")?.trim() || null;
  const versions = await prisma.quizPracticeVersion.findMany({
    where: {
      quizId: quiz.id,
      status: { not: "DISCARDED" },
      ...(batchId ? { batchId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { slotIndex: "asc" }],
    // One round is small and bounded by MAX_IN_FLIGHT per request; the full
    // history view is capped.
    ...(batchId ? {} : { take: 120 }),
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
    quizName: quiz.name,
    versions: versions.map((v) => ({
      ...v,
      standaloneQuiz: v.standaloneQuizId
        ? (standaloneById.get(v.standaloneQuizId) ?? null)
        : null,
      questions: parseJson(v.questions, []),
      sourceSnapshot: parseJson(v.sourceSnapshot, []),
      objectives: parseJson(v.objectives, []),
      validation: parseJson(v.validation, null),
      questionFeedback: parseJson<QuestionRevision[] | null>(
        v.questionFeedback,
        null,
      ),
      slotIndex: v.slotIndex,
      completedCount: v.completedCount,
      totalCount: v.totalCount,
    })),
  });
}

const sampleItemSchema = z.object({
  question: variantQuestionSchema,
  check: verificationSchema.shape.reviews.element,
});
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    variation: z.enum(["NUMBERS", "CONTEXT"]).optional(),
    mix: variantMixSchema.optional(),
    objectives: objectiveSchema,
    count: z.number().int().min(1).max(4).default(1),
    bothModes: z.boolean().default(false),
    purpose: z.enum(["ALTERNATE", "STANDALONE"]).default("ALTERNATE"),
    // Append to an existing round ("Generate two more") instead of starting one.
    batchId: z.string().min(1).max(100).optional(),
    // Verified modal samples to reuse as the first question of a draft.
    seedSamples: z
      .object({
        numbersSample: sampleItemSchema.optional(),
        contextSample: sampleItemSchema.optional(),
      })
      .optional(),
  })
  .refine((b) => b.mix || (b.name && b.variation));

/** A verified sample, if it still matches its current source question. */
function usableSample(
  sample: z.infer<typeof sampleItemSchema> | undefined,
  sources: VariantQuestion[],
) {
  if (!sample) return null;
  const source = sources.find((s) => s.id === sample.question.sourceQuestionId);
  if (!source) return null;
  try {
    const [question] = validateVariant({ questions: [sample.question] }, [
      source,
    ]);
    const [check] = validateVerification({ reviews: [sample.check] }, [
      question,
    ]);
    return { question, check };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest, context: Context) {
  const quiz = await managedVariantQuiz(context);
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
  const unsupported = variantSupportError(quiz);
  if (unsupported)
    return NextResponse.json({ error: unsupported }, { status: 400 });
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
  const sources = quiz.questions.map((q) =>
    sourceFromQuestion(q, objectiveById.get(q.id) ?? ""),
  );
  if (!sourcesHaveValidKeys(sources))
    return NextResponse.json({ error: INVALID_KEYS_ERROR }, { status: 400 });

  const { mix } = body.data;
  const name = body.data.name ?? "Version";
  const perMode: Record<Variation, number> = mix
    ? { NUMBERS: MIX_COUNTS[mix].numbers, CONTEXT: MIX_COUNTS[mix].context }
    : body.data.bothModes
      ? { NUMBERS: body.data.count, CONTEXT: body.data.count }
      : {
          NUMBERS: body.data.variation === "NUMBERS" ? body.data.count : 0,
          CONTEXT: body.data.variation === "CONTEXT" ? body.data.count : 0,
        };
  const modes = (["NUMBERS", "CONTEXT"] as const).filter((m) => perMode[m]);
  const requested = perMode.NUMBERS + perMode.CONTEXT;
  const seeds: Record<Variation, ReturnType<typeof usableSample>> = {
    NUMBERS: usableSample(body.data.seedSamples?.numbersSample, sources),
    CONTEXT: usableSample(body.data.seedSamples?.contextSample, sources),
  };

  const outcome = await prisma.$transaction(async (tx) => {
    const inFlight = await tx.quizPracticeVersion.count({
      where: { quizId: quiz.id, status: { in: ["QUEUED", "GENERATING"] } },
    });
    let batchId = body.data.batchId;
    let purpose = body.data.purpose;
    const batch = batchId
      ? await tx.quizPracticeVersion.findMany({
          where: { quizId: quiz.id, batchId },
          select: { variation: true, purpose: true, slotIndex: true },
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
    let slotIndex = batch.length
      ? Math.max(...batch.map((v) => v.slotIndex)) + 1
      : 0;
    const created = [];
    for (const variation of modes) {
      const offset = batch.filter((v) => v.variation === variation).length;
      for (let i = 0; i < perMode[variation]; i++) {
        // Seed a verified modal sample into the first new draft of its mode.
        const seed = i === 0 ? seeds[variation] : null;
        created.push(
          await tx.quizPracticeVersion.create({
            data: {
              quizId: quiz.id,
              name:
                requested === 1 && !offset
                  ? name
                  : `${name.slice(0, 80)} · ${variation === "NUMBERS" ? "Numbers" : "Context"} ${offset + i + 1}`,
              variation,
              batchId,
              purpose,
              slotIndex: slotIndex++,
              requestedById: quiz.actor.userId,
              totalCount: sources.length,
              objectives: JSON.stringify(objectives),
              sourceSnapshot: JSON.stringify(sources),
              ...(seed
                ? {
                    questions: JSON.stringify([seed.question]),
                    validation: JSON.stringify([seed.check]),
                    completedCount: 1,
                  }
                : {}),
            },
          }),
        );
      }
    }
    await recordVariantBatchState(tx, {
      batchId,
      quizId: quiz.id,
      requestedById: quiz.actor.userId,
      recipientRole: recipientRole(quiz),
      appOrigin: safeAppOrigin(req),
      kind: "INITIAL",
    });
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
  const failed = await queueAll(versions.map((v) => v.id));
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

/** Queue every id; returns the first failure response, if any. */
async function queueAll(ids: string[]) {
  const results = await Promise.all(ids.map((id) => queueVersion(id)));
  return results.find((result) => !result.ok) ?? null;
}

const feedbackSchema = z.string().trim().min(1).max(2000);
const changeSchema = z.object({
  versionId: z.string().optional(),
  action: z.enum([
    "publish",
    "retire",
    "retry",
    "edit",
    "discard",
    "revise",
    "standalone",
    "revise_batch",
    "publish_batch",
  ]),
  questions: z.unknown().optional(),
  feedback: feedbackSchema.optional(),
  questionRevisions: questionRevisionListSchema.optional(),
  batchId: z.string().min(1).max(100).optional(),
  revisions: z
    .array(
      z.object({
        versionId: z.string().min(1),
        questionRevisions: questionRevisionListSchema.optional(),
        feedback: feedbackSchema.optional(),
      }),
    )
    .min(1)
    .max(MAX_IN_FLIGHT * 5)
    .optional(),
});
type SingleAction = Exclude<
  z.infer<typeof changeSchema>["action"],
  "revise_batch" | "publish_batch"
>;
// Which statuses each action may start from.
const FROM: Record<SingleAction, string[]> = {
  publish: ["REVIEW"],
  standalone: ["REVIEW"],
  edit: ["REVIEW", "FAILED"],
  retire: ["PUBLISHED"],
  retry: ["FAILED"],
  discard: ["REVIEW", "FAILED"],
  revise: ["REVIEW", "FAILED"],
};
const REVISABLE = ["REVIEW", "FAILED"];
const conflict = () =>
  NextResponse.json(
    { error: "Version changed. Reload before continuing." },
    { status: 409 },
  );
const invalid = (error = "Invalid version action") =>
  NextResponse.json({ error }, { status: 400 });
const staleQuiz = () =>
  NextResponse.json(
    {
      error:
        "The quiz changed since these versions were generated (questions were added, removed or edited). Generate new versions before publishing.",
    },
    { status: 409 },
  );

/** Revision requests must name distinct questions of the draft's snapshot. */
function revisionsFitSnapshot(
  revisions: QuestionRevision[] | undefined,
  sourceSnapshot: string,
) {
  if (!revisions) return true;
  const ids = new Set(
    parseJson<VariantQuestion[]>(sourceSnapshot, []).map((s) => s.id),
  );
  return (
    new Set(revisions.map((r) => r.sourceQuestionId)).size ===
      revisions.length && revisions.every((r) => ids.has(r.sourceQuestionId))
  );
}

type VersionRow = NonNullable<
  Awaited<ReturnType<typeof prisma.quizPracticeVersion.findFirst>>
>;

/** Data for the queued draft that replaces `old` with teacher feedback. */
function replacementData(
  quiz: ManagedVariantQuiz,
  old: VersionRow,
  revision: { feedback?: string; questionRevisions?: QuestionRevision[] },
) {
  const totalCount = parseJson<unknown[]>(old.sourceSnapshot, []).length;
  const hadQuestions = parseJson<unknown[]>(old.questions, []).length > 0;
  return {
    quizId: quiz.id,
    name: old.name,
    variation: old.variation,
    batchId: old.batchId,
    purpose: old.purpose,
    slotIndex: old.slotIndex,
    objectives: old.objectives,
    sourceSnapshot: old.sourceSnapshot,
    requestedById: quiz.actor.userId,
    revisedFromId: old.id,
    feedback: revision.feedback ?? null,
    questionFeedback: revision.questionRevisions
      ? JSON.stringify(revision.questionRevisions)
      : null,
    totalCount,
    // Unflagged questions carry over unchanged from a non-empty draft.
    completedCount:
      revision.questionRevisions && hadQuestions
        ? Math.max(0, totalCount - revision.questionRevisions.length)
        : 0,
  };
}

class Conflict extends Error {}

export async function PATCH(req: NextRequest, context: Context) {
  const quiz = await managedVariantQuiz(context);
  if (!quiz)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  const body = changeSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return invalid();
  const { action } = body.data;

  if (action === "revise_batch") {
    const { batchId, revisions } = body.data;
    if (
      !batchId ||
      !revisions ||
      new Set(revisions.map((r) => r.versionId)).size !== revisions.length ||
      revisions.some((r) => !r.feedback && !r.questionRevisions)
    )
      return invalid(
        "Give every revised version feedback or per-question reasons.",
      );
    const rows = await prisma.quizPracticeVersion.findMany({
      where: {
        id: { in: revisions.map((r) => r.versionId) },
        quizId: quiz.id,
        batchId,
      },
    });
    if (rows.length !== revisions.length)
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (rows.some((r) => !REVISABLE.includes(r.status))) return conflict();
    if (
      revisions.some(
        (r) =>
          !revisionsFitSnapshot(
            r.questionRevisions,
            byId.get(r.versionId)!.sourceSnapshot,
          ),
      )
    )
      return invalid("Revision reasons must name questions in that version.");
    let created: { id: string }[];
    try {
      created = await prisma.$transaction(async (tx) => {
        const out = [];
        for (const revision of revisions) {
          const old = byId.get(revision.versionId)!;
          const discarded = await tx.quizPracticeVersion.updateMany({
            where: {
              id: old.id,
              status: old.status,
              updatedAt: old.updatedAt,
            },
            data: { status: "DISCARDED" },
          });
          if (!discarded.count) throw new Conflict();
          out.push(
            await tx.quizPracticeVersion.create({
              data: replacementData(quiz, old, revision),
            }),
          );
        }
        // One cycle bump for the whole submission: exactly one "revisions
        // ready" notice fires after every replacement settles.
        await recordVariantBatchState(tx, {
          batchId,
          quizId: quiz.id,
          requestedById: quiz.actor.userId,
          recipientRole: recipientRole(quiz),
          appOrigin: safeAppOrigin(req),
          kind: "REVISION",
        });
        return out;
      });
    } catch (error) {
      if (error instanceof Conflict) return conflict();
      throw error;
    }
    const failed = await queueAll(created.map((c) => c.id));
    if (failed) return failed;
    return NextResponse.json(
      {
        id: created[0].id,
        ids: created.map((c) => c.id),
        batchId,
        status: "QUEUED",
      },
      { status: 202 },
    );
  }

  if (action === "publish_batch") {
    const { batchId } = body.data;
    if (!batchId) return invalid();
    const drafts = await prisma.quizPracticeVersion.findMany({
      where: { quizId: quiz.id, batchId, status: "REVIEW" },
      select: { id: true, sourceSnapshot: true, updatedAt: true },
    });
    if (!drafts.length)
      return NextResponse.json(
        { error: "No reviewed versions in this round are ready to publish." },
        { status: 409 },
      );
    if (drafts.some((d) => !snapshotMatchesQuiz(d.sourceSnapshot, quiz)))
      return staleQuiz();
    const publishedCount = await prisma.$transaction(async (tx) => {
      let count = 0;
      for (const d of drafts) {
        const changed = await tx.quizPracticeVersion.updateMany({
          where: { id: d.id, status: "REVIEW", updatedAt: d.updatedAt },
          data: { status: "PUBLISHED", error: null },
        });
        count += changed.count;
      }
      return count;
    });
    return NextResponse.json({ publishedCount, status: "PUBLISHED" });
  }

  const { versionId } = body.data;
  if (
    !versionId ||
    (action === "revise" && !body.data.feedback && !body.data.questionRevisions)
  )
    return invalid();
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
    if (
      !revisionsFitSnapshot(body.data.questionRevisions, version.sourceSnapshot)
    )
      return invalid("Revision reasons must name questions in that version.");
    const revision = await prisma.$transaction(async (tx) => {
      const discarded = await tx.quizPracticeVersion.updateMany({
        where: fence,
        data: { status: "DISCARDED" },
      });
      if (!discarded.count) return null;
      const next = await tx.quizPracticeVersion.create({
        data: replacementData(quiz, version, {
          feedback: body.data.feedback,
          questionRevisions: body.data.questionRevisions,
        }),
      });
      if (version.batchId)
        await recordVariantBatchState(tx, {
          batchId: version.batchId,
          quizId: quiz.id,
          requestedById: quiz.actor.userId,
          recipientRole: recipientRole(quiz),
          appOrigin: safeAppOrigin(req),
          kind: "REVISION",
        });
      return next;
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
  if (action === "publish" && !questionsStillMatchQuiz(version.questions, quiz))
    return staleQuiz();
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
            completedCount: 0,
          }
        : {}),
      // A fresh retry regenerates from scratch; a teacher edit is re-verified.
      ...(action === "retry"
        ? {
            validation: null,
            completedCount: 0,
            ...(version.teacherEdited ? {} : { questions: "[]" }),
          }
        : {}),
    },
  });
  if (!changed.count) return conflict();
  if (status === "QUEUED") return queueVersion(versionId);
  return NextResponse.json({ id: versionId, status });
}
