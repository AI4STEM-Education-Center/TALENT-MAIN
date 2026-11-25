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
import {
  computeQuestionSourceHash,
  isSupportedCoachQuestionShape,
} from "@/lib/wrong-answer-coach-rules";
import {
  ensureQuizCoachMetadata,
  labelVariantQuestions,
} from "@/lib/wrong-answer-coach-labeling";

function countMatchingEligibleQuestions(
  version: { sourceSnapshot: string; questions: string } | null,
  eligibleWithHash: Array<{ id: string; hash: string }>,
): number {
  if (!version || eligibleWithHash.length === 0) return 0;
  try {
    const sources = JSON.parse(version.sourceSnapshot) as VariantQuestion[];
    const vQuestions = JSON.parse(version.questions) as VariantQuestion[];
    const vBySource = new Set(vQuestions.map((q) => q.sourceQuestionId));
    let matched = 0;
    for (const eq of eligibleWithHash) {
      if (!vBySource.has(eq.id)) continue;
      const snap = sources.find(
        (s) => s.id === eq.id || s.sourceQuestionId === eq.id,
      );
      if (!snap) continue;
      const snapHash = computeQuestionSourceHash({
        text: snap.text,
        answerMode: snap.answerMode,
        options: snap.options,
      });
      if (snapHash === eq.hash) matched += 1;
    }
    return matched;
  } catch {
    return 0;
  }
}

/** Drafts generating at once per quiz; bounds provider bursts and cost. */
const MAX_IN_FLIGHT = 10;

type Context = VariantRouteContext;
type Variation = "NUMBERS" | "CONTEXT" | "COACH_CHECK3" | "COACH_HELDOUT";

const ALL_VARIATIONS: readonly Variation[] = [
  "NUMBERS",
  "CONTEXT",
  "COACH_CHECK3",
  "COACH_HELDOUT",
];

function draftNameFor(
  base: string,
  variation: Variation,
  offset: number,
  index: number,
  requested: number,
): string {
  if (variation === "COACH_CHECK3") {
    const suffix = offset + index > 0 ? ` ${offset + index + 1}` : "";
    return `${base.slice(0, 60)} · Coach 2nd Q (Check 3)${suffix}`;
  }
  if (variation === "COACH_HELDOUT") {
    const suffix = offset + index > 0 ? ` ${offset + index + 1}` : "";
    return `${base.slice(0, 60)} · Coach Held-Out Q${suffix}`;
  }
  if (requested === 1 && !offset) return base;
  return `${base.slice(0, 80)} · ${variation === "NUMBERS" ? "Numbers" : "Context"} ${offset + index + 1}`;
}

function defaultCoachRoleFor(
  variation: Variation,
  purpose: "ALTERNATE" | "STANDALONE",
  hasCoachEligibleQuestions: boolean,
): "PRACTICE" | "COACH_CHECK3" | "COACH_HELDOUT" {
  if (purpose !== "ALTERNATE" || !hasCoachEligibleQuestions) return "PRACTICE";
  if (variation === "COACH_CHECK3") return "COACH_CHECK3";
  if (variation === "COACH_HELDOUT") return "COACH_HELDOUT";
  return "PRACTICE";
}

const normalizeSeedText = (text: string) =>
  text.trim().replace(/\s+/g, " ").toLowerCase();

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
  const eligibleQuestions = quiz.questions.filter(
    (q) =>
      isSupportedCoachQuestionShape({
        answerMode: q.answerMode,
        figureStorageKey: q.figureStorageKey,
        options: q.options,
      }).ok,
  );
  const [standalone, coachMetaRows] = await Promise.all([
    prisma.quiz.findMany({
      where: {
        id: {
          in: versions.flatMap((v) =>
            v.standaloneQuizId ? [v.standaloneQuizId] : [],
          ),
        },
      },
      select: { id: true, name: true },
    }),
    eligibleQuestions.length > 0
      ? prisma.questionCoachMetadata.findMany({
          where: { questionId: { in: eligibleQuestions.map((q) => q.id) } },
          select: { questionId: true, status: true, sourceHash: true },
        })
      : Promise.resolve([]),
  ]);
  const standaloneById = new Map(standalone.map((q) => [q.id, q]));
  const metaByQ = new Map(coachMetaRows.map((m) => [m.questionId, m]));

  const eligibleWithHash = eligibleQuestions.map((q) => ({
    id: q.id,
    hash: computeQuestionSourceHash({
      text: q.text,
      answerMode: q.answerMode,
      figureStorageKey: q.figureStorageKey,
      figureAlt: q.figureAlt,
      options: q.options,
    }),
    coachMetadata: metaByQ.get(q.id) ?? null,
  }));
  const metadataReadyCount = eligibleWithHash.filter(
    (q) =>
      q.coachMetadata?.status === "READY" &&
      q.coachMetadata.sourceHash === q.hash,
  ).length;
  const published = versions.filter((v) => v.status === "PUBLISHED");
  const check3 = published.find((v) => v.coachRole === "COACH_CHECK3") ?? null;
  const heldOut =
    published.find((v) => v.coachRole === "COACH_HELDOUT") ?? null;
  const check3MatchedCount = countMatchingEligibleQuestions(
    check3,
    eligibleWithHash,
  );
  const heldOutMatchedCount = countMatchingEligibleQuestions(
    heldOut,
    eligibleWithHash,
  );
  const matchedQuestionCount = Math.min(
    check3MatchedCount,
    heldOutMatchedCount,
  );
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
    coachReadiness: {
      eligibleQuestionCount: eligibleQuestions.length,
      metadataReadyCount,
      matchedQuestionCount,
      check3VersionId: check3?.id ?? null,
      check3Labeled: Boolean(check3?.coachLabeledAt),
      heldOutVersionId: heldOut?.id ?? null,
      heldOutLabeled: Boolean(heldOut?.coachLabeledAt),
      ready:
        eligibleQuestions.length > 0 &&
        matchedQuestionCount > 0 &&
        metadataReadyCount === eligibleQuestions.length &&
        Boolean(check3?.coachLabeledAt) &&
        Boolean(heldOut?.coachLabeledAt),
    },
  });
}

const sampleItemSchema = z.object({
  question: variantQuestionSchema,
  check: verificationSchema.shape.reviews.element,
});
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    variation: z
      .enum(["NUMBERS", "CONTEXT", "COACH_CHECK3", "COACH_HELDOUT"])
      .optional(),
    mix: variantMixSchema.optional(),
    includeCoach: z.boolean().optional(),
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
        coachCheck3Sample: sampleItemSchema.optional(),
        coachHeldOutSample: sampleItemSchema.optional(),
      })
      .optional(),
  })
  .refine((b) => b.mix || (b.name && b.variation));

/**
 * A verified sample, if it still matches its current source question and does
 * not repeat a question already used in the source quiz, an existing version,
 * or another draft in this same round.
 */
function usableSample(
  sample: z.infer<typeof sampleItemSchema> | undefined,
  sources: VariantQuestion[],
  seenTextsBySource: Map<string, Set<string>>,
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
    const key = normalizeSeedText(question.text);
    const seen = seenTextsBySource.get(source.id) ?? new Set<string>();
    if (seen.has(key)) return null;
    seen.add(key);
    seenTextsBySource.set(source.id, seen);
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
  const hasCoachEligibleQuestions = quiz.questions.some(
    (q) =>
      isSupportedCoachQuestionShape({
        answerMode: q.answerMode,
        figureStorageKey: q.figureStorageKey,
        options: q.options,
      }).ok,
  );

  // Collect all question texts already present in the source quiz or any
  // non-discarded version so cached calibration samples are never re-seeded
  // across rounds (preventing Practice/Coach overlap and duplicate rounds).
  const existingVersions = await prisma.quizPracticeVersion.findMany({
    where: {
      quizId: quiz.id,
      status: { not: "DISCARDED" },
    },
    select: { questions: true },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  const seenTextsBySource = new Map<string, Set<string>>();
  for (const s of sources) {
    seenTextsBySource.set(s.id, new Set([normalizeSeedText(s.text)]));
  }
  for (const existing of existingVersions) {
    for (const q of parseJson<VariantQuestion[]>(existing.questions, [])) {
      if (!q?.sourceQuestionId || typeof q.text !== "string") continue;
      const set =
        seenTextsBySource.get(q.sourceQuestionId) ?? new Set<string>();
      set.add(normalizeSeedText(q.text));
      seenTextsBySource.set(q.sourceQuestionId, set);
    }
  }

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
      purpose = batch[0].purpose as typeof purpose;
    } else {
      if (inFlight) return "busy" as const;
      batchId = crypto.randomUUID();
    }

    const includeCoachInRound = Boolean(
      mix &&
      !body.data.batchId &&
      purpose === "ALTERNATE" &&
      hasCoachEligibleQuestions &&
      body.data.includeCoach !== false,
    );
    const perMode: Record<Variation, number> = mix
      ? {
          NUMBERS: MIX_COUNTS[mix].numbers,
          CONTEXT: MIX_COUNTS[mix].context,
          COACH_CHECK3: includeCoachInRound ? 1 : 0,
          COACH_HELDOUT: includeCoachInRound ? 1 : 0,
        }
      : body.data.bothModes
        ? {
            NUMBERS: body.data.count,
            CONTEXT: body.data.count,
            COACH_CHECK3: 0,
            COACH_HELDOUT: 0,
          }
        : {
            NUMBERS: body.data.variation === "NUMBERS" ? body.data.count : 0,
            CONTEXT: body.data.variation === "CONTEXT" ? body.data.count : 0,
            COACH_CHECK3:
              body.data.variation === "COACH_CHECK3" ? body.data.count : 0,
            COACH_HELDOUT:
              body.data.variation === "COACH_HELDOUT" ? body.data.count : 0,
          };
    const modes = ALL_VARIATIONS.filter((m) => perMode[m]);
    const requested =
      perMode.NUMBERS +
      perMode.CONTEXT +
      perMode.COACH_CHECK3 +
      perMode.COACH_HELDOUT;
    if (body.data.batchId && inFlight + requested > MAX_IN_FLIGHT)
      return "busy" as const;

    const seeds: Record<Variation, ReturnType<typeof usableSample>> = {
      NUMBERS: usableSample(
        body.data.seedSamples?.numbersSample,
        sources,
        seenTextsBySource,
      ),
      CONTEXT: usableSample(
        body.data.seedSamples?.contextSample,
        sources,
        seenTextsBySource,
      ),
      COACH_CHECK3: usableSample(
        body.data.seedSamples?.coachCheck3Sample,
        sources,
        seenTextsBySource,
      ),
      COACH_HELDOUT: usableSample(
        body.data.seedSamples?.coachHeldOutSample,
        sources,
        seenTextsBySource,
      ),
    };

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
              name: draftNameFor(name, variation, offset, i, requested),
              variation,
              coachRole: defaultCoachRoleFor(
                variation,
                purpose,
                hasCoachEligibleQuestions,
              ),
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
    "set_coach_role",
  ]),
  coachRole: z.enum(["PRACTICE", "COACH_CHECK3", "COACH_HELDOUT"]).optional(),
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
  set_coach_role: ["PUBLISHED"],
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
    coachRole: old.coachRole,
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
class CoachRoleActiveConflict extends Error {}

async function displaceExistingCoachRoles(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  quizId: string,
  targetRoles: string[],
  excludeIds: string[],
) {
  const uniqueRoles = [...new Set(targetRoles.filter((r) => r !== "PRACTICE"))];
  if (uniqueRoles.length === 0) return;

  const displaced = await tx.quizPracticeVersion.findMany({
    where: {
      quizId,
      status: "PUBLISHED",
      coachRole: { in: uniqueRoles },
      id: { notIn: excludeIds },
    },
    select: { id: true },
  });
  if (displaced.length === 0) return;

  const displacedIds = displaced.map((d) => d.id);
  const activeSessions = await tx.wrongAnswerCoachSession.count({
    where: {
      state: { notIn: ["COMPLETED", "INCOMPLETE"] },
      OR: [
        { check3VersionId: { in: displacedIds } },
        { heldOutVersionId: { in: displacedIds } },
      ],
    },
  });
  if (activeSessions > 0) {
    throw new CoachRoleActiveConflict();
  }

  await tx.quizPracticeVersion.updateMany({
    where: { id: { in: displacedIds }, status: "PUBLISHED" },
    data: { coachRole: "PRACTICE" },
  });
}

function triggerCoachLabelingForPublished(
  quizId: string,
  publishedCoachDrafts: Array<{
    id: string;
    questions: string;
    coachLabeledAt: Date | null;
  }>,
) {
  if (publishedCoachDrafts.length === 0) return;
  void ensureQuizCoachMetadata(quizId).catch(() => {});
  for (const draft of publishedCoachDrafts) {
    if (draft.coachLabeledAt) continue;
    void (async () => {
      try {
        const parsed = JSON.parse(draft.questions) as VariantQuestion[];
        const { questions: labeledQs, labeled } =
          await labelVariantQuestions(parsed);
        if (labeled) {
          await prisma.quizPracticeVersion.updateMany({
            where: {
              id: draft.id,
              status: "PUBLISHED",
              coachLabeledAt: null,
              questions: draft.questions,
            },
            data: {
              questions: JSON.stringify(labeledQs),
              coachLabeledAt: new Date(),
            },
          });
        }
      } catch {
        // Worker sweeper will retry.
      }
    })();
  }
}

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
      select: {
        id: true,
        sourceSnapshot: true,
        updatedAt: true,
        coachRole: true,
        questions: true,
        coachLabeledAt: true,
      },
      orderBy: { slotIndex: "asc" },
    });
    if (!drafts.length)
      return NextResponse.json(
        { error: "No reviewed versions in this round are ready to publish." },
        { status: 409 },
      );
    if (drafts.some((d) => !snapshotMatchesQuiz(d.sourceSnapshot, quiz)))
      return staleQuiz();
    // Ensure at most one draft per Coach role is published from this batch.
    const claimedRoles = new Set<string>();
    const assignedRoles = new Map<string, string>();
    for (const d of drafts) {
      if (d.coachRole !== "PRACTICE" && !claimedRoles.has(d.coachRole)) {
        claimedRoles.add(d.coachRole);
        assignedRoles.set(d.id, d.coachRole);
      } else {
        assignedRoles.set(d.id, "PRACTICE");
      }
    }
    let publishedDrafts: typeof drafts = [];
    try {
      publishedDrafts = await prisma.$transaction(async (tx) => {
        const published: typeof drafts = [];
        const rolesToDisplace: string[] = [];
        for (const d of drafts) {
          const role = assignedRoles.get(d.id) ?? "PRACTICE";
          const changed = await tx.quizPracticeVersion.updateMany({
            where: { id: d.id, status: "REVIEW", updatedAt: d.updatedAt },
            data: { status: "PUBLISHED", coachRole: role, error: null },
          });
          if (changed.count > 0) {
            published.push(d);
            if (role !== "PRACTICE") rolesToDisplace.push(role);
          }
        }
        if (published.length === 0) throw new Conflict();
        // Only displace incumbents for Coach roles whose replacement actually
        // published; if an active session blocks displacement, throw to roll
        // back the entire batch atomically.
        await displaceExistingCoachRoles(
          tx,
          quiz.id,
          rolesToDisplace,
          published.map((d) => d.id),
        );
        return published;
      });
    } catch (error) {
      if (error instanceof Conflict) return conflict();
      if (error instanceof CoachRoleActiveConflict) {
        return NextResponse.json(
          {
            error:
              "Cannot replace the active Wrong Answer Coach version while students have in-progress Wrong Answer Coach sessions using it.",
          },
          { status: 409 },
        );
      }
      throw error;
    }
    triggerCoachLabelingForPublished(
      quiz.id,
      publishedDrafts.filter((d) => assignedRoles.get(d.id) !== "PRACTICE"),
    );
    return NextResponse.json({
      publishedCount: publishedDrafts.length,
      status: "PUBLISHED",
    });
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
  if (action === "set_coach_role") {
    const coachRole = body.data.coachRole;
    if (!coachRole) {
      return NextResponse.json(
        { error: "coachRole is required." },
        { status: 400 },
      );
    }
    if (version.status !== "PUBLISHED") {
      return NextResponse.json(
        {
          error:
            "Only published versions can be assigned to Wrong Answer Coach.",
        },
        { status: 409 },
      );
    }

    if (coachRole !== "PRACTICE") {
      const priorPracticeCount = await prisma.quizPracticeAttempt.count({
        where: { versionId },
      });
      if (priorPracticeCount > 0) {
        return NextResponse.json(
          {
            error:
              "This version already has student practice attempts and cannot be used for Wrong Answer Coach. Publish a fresh version instead.",
          },
          { status: 409 },
        );
      }

      const eligibleWithHash = quiz.questions
        .filter(
          (q) =>
            isSupportedCoachQuestionShape({
              answerMode: q.answerMode,
              figureStorageKey: q.figureStorageKey,
              options: q.options,
            }).ok,
        )
        .map((q) => ({
          id: q.id,
          hash: computeQuestionSourceHash({
            text: q.text,
            answerMode: q.answerMode,
            figureStorageKey: q.figureStorageKey,
            figureAlt: q.figureAlt,
            options: q.options,
          }),
        }));
      const matchedCount = countMatchingEligibleQuestions(
        version,
        eligibleWithHash,
      );
      if (matchedCount === 0) {
        return NextResponse.json(
          {
            error:
              "This version is out of date with the current quiz questions. Generate and publish a fresh alternative set first.",
          },
          { status: 400 },
        );
      }
    }

    try {
      await prisma.$transaction(async (tx) => {
        const versionsReturningToPractice: string[] = [];
        if (coachRole === "PRACTICE" && version.coachRole !== "PRACTICE") {
          versionsReturningToPractice.push(versionId);
        } else if (coachRole !== "PRACTICE") {
          const displaced = await tx.quizPracticeVersion.findMany({
            where: {
              quizId: quiz.id,
              status: "PUBLISHED",
              coachRole,
              id: { not: versionId },
            },
            select: { id: true },
          });
          versionsReturningToPractice.push(...displaced.map((d) => d.id));
        }
        if (versionsReturningToPractice.length > 0) {
          const activeSessions = await tx.wrongAnswerCoachSession.count({
            where: {
              state: { notIn: ["COMPLETED", "INCOMPLETE"] },
              OR: [
                { check3VersionId: { in: versionsReturningToPractice } },
                { heldOutVersionId: { in: versionsReturningToPractice } },
              ],
            },
          });
          if (activeSessions > 0) {
            throw new CoachRoleActiveConflict();
          }
        }
        if (coachRole !== "PRACTICE") {
          await tx.quizPracticeVersion.updateMany({
            where: {
              quizId: quiz.id,
              status: "PUBLISHED",
              coachRole,
              id: { not: versionId },
            },
            data: { coachRole: "PRACTICE" },
          });
        }
        await tx.quizPracticeVersion.update({
          where: { id: versionId },
          data: { coachRole },
        });
      });
    } catch (error) {
      if (error instanceof CoachRoleActiveConflict) {
        return NextResponse.json(
          {
            error:
              "Cannot move a Coach version back to Practice while students have active Wrong Answer Coach sessions using it.",
          },
          { status: 409 },
        );
      }
      throw error;
    }
    if (coachRole !== "PRACTICE") {
      void ensureQuizCoachMetadata(quiz.id).catch(() => {});
      if (!version.coachLabeledAt) {
        void (async () => {
          try {
            const parsed = JSON.parse(version.questions) as VariantQuestion[];
            const { questions: labeledQs, labeled } =
              await labelVariantQuestions(parsed);
            if (labeled) {
              await prisma.quizPracticeVersion.updateMany({
                where: { id: versionId, coachLabeledAt: null },
                data: {
                  questions: JSON.stringify(labeledQs),
                  coachLabeledAt: new Date(),
                },
              });
            }
          } catch {
            // Worker sweeper will retry.
          }
        })();
      }
    }
    return NextResponse.json({
      id: versionId,
      status: version.status,
      coachRole,
    });
  }
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
  if (action === "publish" && version.coachRole !== "PRACTICE") {
    // Coach versions must match the exact current quiz snapshot and have at
    // least one Coach-eligible question before replacing a working incumbent.
    const hasCoachEligible = quiz.questions.some(
      (q) =>
        isSupportedCoachQuestionShape({
          answerMode: q.answerMode,
          figureStorageKey: q.figureStorageKey,
          options: q.options,
        }).ok,
    );
    if (!hasCoachEligible || !snapshotMatchesQuiz(version.sourceSnapshot, quiz))
      return staleQuiz();
    try {
      await prisma.$transaction(async (tx) => {
        const changed = await tx.quizPracticeVersion.updateMany({
          where: fence,
          data: { status: "PUBLISHED", error: null },
        });
        if (!changed.count) throw new Conflict();
        await displaceExistingCoachRoles(
          tx,
          quiz.id,
          [version.coachRole],
          [versionId],
        );
      });
    } catch (error) {
      if (error instanceof Conflict) return conflict();
      if (error instanceof CoachRoleActiveConflict) {
        return NextResponse.json(
          {
            error:
              "Cannot replace the active Wrong Answer Coach version while students have in-progress Wrong Answer Coach sessions using it.",
          },
          { status: 409 },
        );
      }
      throw error;
    }
    triggerCoachLabelingForPublished(quiz.id, [version]);
    return NextResponse.json({
      id: versionId,
      status: "PUBLISHED",
      coachRole: version.coachRole,
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
      ...(action === "retire" ? { coachRole: "PRACTICE" } : {}),
      ...(questions
        ? {
            questions: JSON.stringify(questions),
            validation: null,
            teacherEdited: true,
            completedCount: 0,
            coachLabeledAt: null,
          }
        : {}),
      // A fresh retry regenerates from scratch; a teacher edit is re-verified.
      ...(action === "retry"
        ? {
            validation: null,
            completedCount: 0,
            coachLabeledAt: null,
            ...(version.teacherEdited ? {} : { questions: "[]" }),
          }
        : {}),
    },
  });
  if (!changed.count) return conflict();
  if (status === "QUEUED") return queueVersion(versionId);
  return NextResponse.json({ id: versionId, status });
}
