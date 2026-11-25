import {
  buildQuizVariantGenerationPrompt,
  buildQuizVariantVerificationPrompt,
  QUIZ_VARIANT_SYSTEM_PROMPT,
  type QuizVariantGenerationPromptInput,
} from "./quiz-variant-prompts";
import { requestQuizVariant } from "./quiz-variant-requests";
import { z } from "zod";
import { prisma } from "./prisma";
import {
  createOpenAIClient,
  resolveProvider,
  thinkingParams,
} from "./ai-provider";
import {
  streamJsonCompletion,
  streamOptionsFor,
  transportFor,
} from "./ai-streaming";
import {
  checkConceptualNumberMisuse,
  checkContextRewriteDistinctness,
  checkWorkedSolutionConsistency,
  objectiveSchema,
  questionRevisionListSchema,
  validateVariant,
  validateVerification,
  variantGenerationSchema,
  verificationSchema,
  type Objective,
  type QuestionRevision,
  type VariantQuestion,
  type VerificationReview,
} from "./quiz-variants";
import { notifyVariantBatchIfComplete } from "./quiz-variant-notifications";
import { logSystemEvent } from "./system-log";
import { errorMessage } from "./errors";

/** Generate-and-verify rounds per job before a draft is reported as failed. */
export const MAX_GENERATION_ATTEMPTS = 4;
/** Extra rounds per mode for the synchronous one-question sample preview. */
export const SAMPLE_RETRIES = 2;
/** Keep `heartbeatAt` fresh during long provider calls (sweeper uses 20 min). */
const HEARTBEAT_MS = 60_000;

/** A candidate the checks rejected: worth regenerating, unlike transport errors. */
class RejectedCandidate extends Error {}
/** The model declined to vary a flawed source: needs the teacher, not a retry. */
class RefusedSource extends Error {}

function rejectOnError<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    throw new RejectedCandidate(
      error instanceof Error ? error.message : "Candidate failed validation.",
    );
  }
}

type Call = (
  prompt: string,
  schema: z.ZodType,
  name: string,
) => Promise<unknown>;
type Provider = NonNullable<Awaited<ReturnType<typeof resolveProvider>>>;
type Variation = QuizVariantGenerationPromptInput["variation"];

const normalize = (text: string) =>
  text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * OpenAI strict structured outputs require every property to be listed in
 * `required`. Nullable-but-optional fields (e.g. `refusalReason`) still accept
 * `null`, so requiring them keeps strict mode on without changing meaning.
 */
function requireAllProperties(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(requireAllProperties);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node))
    out[key] = requireAllProperties(value);
  if (out.properties && typeof out.properties === "object")
    out.required = Object.keys(out.properties as object);
  return out;
}

function strictSchema(schema: z.ZodType) {
  return requireAllProperties(z.toJSONSchema(schema));
}

function makeCall(
  client: Awaited<ReturnType<typeof createOpenAIClient>>,
  provider: Provider,
  serviceTier: string | null,
  onTokens: (tokens: number) => void,
): Call {
  return async (prompt, schema, name) => {
    const result = await requestQuizVariant(() =>
      streamJsonCompletion(
        client,
        {
          model: provider.model,
          ...(serviceTier
            ? {
                service_tier: serviceTier as "auto" | "default" | "flex",
              }
            : {}),
          ...thinkingParams(provider),
          messages: [
            { role: "system", content: QUIZ_VARIANT_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        },
        { name, strict: true, schema: strictSchema(schema) },
        streamOptionsFor(transportFor(provider), {
          requestOptions: { maxRetries: 0 },
        }),
      ),
    );
    onTokens(result.metrics.completionTokens);
    return result.value;
  };
}

/** Recent drafts of the same quiz, so new candidates do not repeat them. */
async function previousQuestions(quizId: string, excludeId?: string) {
  const siblings = await prisma.quizPracticeVersion.findMany({
    where: {
      quizId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      status: { in: ["REVIEW", "PUBLISHED", "STANDALONE"] },
    },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { questions: true },
  });
  return siblings.flatMap((sibling) => {
    try {
      return JSON.parse(sibling.questions) as VariantQuestion[];
    } catch {
      return [];
    }
  });
}

/**
 * One generation call over `input.sources`. Throws RejectedCandidate when the
 * payload is malformed as a whole; per-question quality problems are reported
 * by `qualityProblem` so verified siblings can be kept.
 */
async function generateCandidates(
  call: Call,
  input: QuizVariantGenerationPromptInput,
  previous: VariantQuestion[],
): Promise<VariantQuestion[]> {
  const value = await call(
    buildQuizVariantGenerationPrompt(input, previous),
    variantGenerationSchema,
    "quiz_variant",
  );
  const raw = value as { questions?: unknown; refusalReason?: unknown };
  if (raw && Array.isArray(raw.questions) && raw.questions.length === 0)
    throw new RefusedSource(
      typeof raw.refusalReason === "string" && raw.refusalReason.trim()
        ? `Source question cannot be varied safely: ${raw.refusalReason.trim()}`
        : "The AI declined to vary this quiz: a source question may be flawed or unsupported. Check its answer key.",
    );
  return rejectOnError(() =>
    validateVariant({ questions: raw?.questions }, input.sources),
  );
}

/** Automatic quality checks for one freshly generated candidate. */
function qualityProblem(
  candidate: VariantQuestion,
  source: VariantQuestion,
  variation: Variation,
  others: VariantQuestion[],
): string | null {
  if (
    others.some(
      (other) =>
        other.sourceQuestionId === candidate.sourceQuestionId &&
        normalize(other.text) === normalize(candidate.text),
    )
  )
    return "This alternative repeats an existing question. Retry to generate a different version.";
  return (
    checkConceptualNumberMisuse(source, candidate) ??
    (variation === "CONTEXT"
      ? checkContextRewriteDistinctness(source, candidate)
      : null) ??
    checkWorkedSolutionConsistency(candidate)
  );
}

type VerifyResult =
  { ok: true; review: VerificationReview } | { ok: false; error: string };

/**
 * Blind, independent solve of each candidate. Returns a per-question verdict
 * so one failing question does not discard its verified siblings.
 */
async function verifyEach(
  call: Call,
  questions: VariantQuestion[],
  sources: VariantQuestion[],
  objectives: Objective[],
): Promise<Map<string, VerifyResult>> {
  const value = await call(
    buildQuizVariantVerificationPrompt(questions, sources, objectives),
    verificationSchema,
    "quiz_variant_review",
  );
  const results = new Map<string, VerifyResult>();
  let reviews: VerificationReview[];
  try {
    reviews = verificationSchema.parse(value).reviews;
  } catch {
    for (const q of questions)
      results.set(q.sourceQuestionId, {
        ok: false,
        error: "Incomplete independent review.",
      });
    return results;
  }
  for (const q of questions) {
    const matching = reviews.filter(
      (r) => r.sourceQuestionId === q.sourceQuestionId,
    );
    try {
      if (matching.length !== 1)
        throw new Error("Incomplete independent review.");
      const [review] = validateVerification({ reviews: matching }, [q]);
      results.set(q.sourceQuestionId, { ok: true, review });
    } catch (error) {
      results.set(q.sourceQuestionId, {
        ok: false,
        error: error instanceof Error ? error.message : "Review failed.",
      });
    }
  }
  return results;
}

/** A stored review that still independently confirms `question`, or null. */
function confirmedReview(
  question: VariantQuestion,
  reviews: VerificationReview[] | null,
): VerificationReview | null {
  const review = reviews?.find(
    (r) => r.sourceQuestionId === question.sourceQuestionId,
  );
  if (!review) return null;
  try {
    return validateVerification({ reviews: [review] }, [question])[0];
  } catch {
    return null;
  }
}

function parseReviews(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as VerificationReview[]) : null;
  } catch {
    return null;
  }
}

function parseQuestionFeedback(
  value: string | null | undefined,
): QuestionRevision[] | null {
  if (!value) return null;
  try {
    return questionRevisionListSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseQuestions(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Synchronous one-question preview for the generation modal: one NUMBERS and
 * one CONTEXT alternative of `source`, each generated, quality-checked and
 * blind-verified (with a couple of retries) in parallel.
 */
export async function generateQuizVariantSample(opts: {
  quizId: string;
  source: VariantQuestion;
  objective: string;
}) {
  const provider = await resolveProvider("quiz_variants");
  if (!provider)
    throw new Error(
      "Assign an AI model to Alternative Quiz Versions in AI Config first.",
    );
  const client = await createOpenAIClient(provider);
  // The teacher is waiting on this preview: never park it in the Flex queue.
  const serviceTier =
    provider.providerType !== "local" && provider.serviceTier
      ? provider.serviceTier === "flex"
        ? "auto"
        : provider.serviceTier
      : null;
  const call = makeCall(client, provider, serviceTier, () => undefined);
  const sources = [opts.source];
  const objectives: Objective[] = [
    { sourceQuestionId: opts.source.id, objective: opts.objective },
  ];
  const previous = await previousQuestions(opts.quizId);
  const seed = crypto.randomUUID();

  async function sample(variation: Variation) {
    const rejections: string[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        const [question] = await generateCandidates(
          call,
          {
            seed: `sample-${seed}-${variation}`,
            variation,
            sources,
            objectives,
            rejections,
          },
          previous,
        );
        const problem = qualityProblem(question, opts.source, variation, [
          opts.source,
          ...previous,
        ]);
        if (problem) throw new RejectedCandidate(problem);
        const verdict = (
          await verifyEach(call, [question], sources, objectives)
        ).get(opts.source.id);
        if (!verdict?.ok)
          throw new RejectedCandidate(
            verdict?.error ?? "Incomplete independent review.",
          );
        return { question, check: verdict.review };
      } catch (error) {
        if (!(error instanceof RejectedCandidate) || attempt >= SAMPLE_RETRIES)
          throw error;
        rejections.push(error.message.slice(0, 500));
      }
    }
  }

  const [numbersSample, contextSample] = await Promise.all([
    sample("NUMBERS"),
    sample("CONTEXT"),
  ]);
  return {
    sourceQuestionId: opts.source.id,
    numbersSample,
    contextSample,
    aiModel: `${provider.providerType}/${provider.model}`,
  };
}

export async function runQuizVariant(versionId: string) {
  const row = await prisma.quizPracticeVersion.findUnique({
    where: { id: versionId },
  });
  if (!row || row.status !== "QUEUED") return;
  const lease = new Date();
  const leaseToken = crypto.randomUUID();
  const claim = await prisma.quizPracticeVersion.updateMany({
    where: { id: versionId, status: "QUEUED", updatedAt: row.updatedAt },
    data: {
      status: "GENERATING",
      leaseToken,
      heartbeatAt: lease,
      updatedAt: lease,
      error: null,
    },
  });
  if (!claim.count) return;

  // Every later write is fenced on (status, leaseToken, updatedAt): a sweeper
  // or a retry that re-claimed the row makes this worker's writes no-ops.
  // Writes are serialized so the heartbeat never races a progress update.
  let leaseTime = lease;
  let lost = false;
  let writing: Promise<unknown> = Promise.resolve();
  const write = (data: Record<string, unknown>): Promise<boolean> => {
    const next = writing.then(async () => {
      if (lost) return false;
      const stamp = new Date(Math.max(Date.now(), leaseTime.getTime() + 1));
      const result = await prisma.quizPracticeVersion.updateMany({
        where: {
          id: versionId,
          status: "GENERATING",
          leaseToken,
          updatedAt: leaseTime,
        },
        data: { ...data, heartbeatAt: stamp, updatedAt: stamp },
      });
      if (result.count) leaseTime = stamp;
      else lost = true;
      return result.count > 0;
    });
    writing = next.catch(() => undefined);
    return next;
  };
  const heartbeat = setInterval(() => {
    void write({}).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let tokens = 0;
  let attempts = row.attempts;
  let aiModel: string | null = null;
  let finalStatus: "REVIEW" | "FAILED" | null = null;
  let sources: VariantQuestion[] = [];
  // Best-known question per source (accepted, awaiting review, or the latest
  // rejected attempt) so a failed draft still shows the teacher something.
  const latest = new Map<string, VariantQuestion>();
  const accepted = new Map<string, VerificationReview>();
  const merged = () =>
    sources.flatMap((s) => {
      const q = latest.get(s.id);
      return q ? [q] : [];
    });
  const acceptedReviews = () =>
    sources.flatMap((s) => {
      const r = accepted.get(s.id);
      return r ? [r] : [];
    });
  let lastCandidate = row.questions;
  try {
    const provider = await resolveProvider("quiz_variants");
    if (!provider)
      throw new Error(
        "Assign an AI model to Alternative Quiz Versions in AI Config first.",
      );
    aiModel = `${provider.providerType}/${provider.model}`;
    const client = await createOpenAIClient(provider);
    sources = JSON.parse(row.sourceSnapshot) as VariantQuestion[];
    const objectives = objectiveSchema.parse(JSON.parse(row.objectives));
    const variation: Variation =
      row.variation === "CONTEXT" ? "CONTEXT" : "NUMBERS";
    const call = makeCall(
      client,
      provider,
      provider.providerType !== "local" && provider.serviceTier
        ? provider.serviceTier
        : null,
      (n) => {
        tokens += n;
      },
    );

    const pendingVerify = new Set<string>();
    const toGenerate = new Set<string>();
    const reasons = new Map<string, string>();
    const replacing: VariantQuestion[] = [];
    const existing = parseQuestions(row.questions);
    const questionFeedback = parseQuestionFeedback(row.questionFeedback);
    const revisedFrom = row.revisedFromId
      ? await prisma.quizPracticeVersion.findUnique({
          where: { id: row.revisedFromId },
          select: { questions: true, validation: true },
        })
      : null;
    let feedback: string | undefined;
    let previousDraft: unknown[] | undefined;

    const keep = (
      questions: VariantQuestion[],
      reviews: VerificationReview[] | null,
    ) => {
      for (const q of questions) {
        latest.set(q.sourceQuestionId, q);
        const review = confirmedReview(q, reviews);
        if (review) accepted.set(q.sourceQuestionId, review);
        else pendingVerify.add(q.sourceQuestionId);
      }
    };

    if (
      existing.length &&
      (row.teacherEdited || existing.length >= sources.length)
    ) {
      // Teacher edits / complete drafts: re-verify, never silently replace
      // (an invalid teacher edit fails the job for teacher attention).
      const questions = validateVariant({ questions: existing }, sources);
      keep(questions, row.teacherEdited ? null : parseReviews(row.validation));
    } else if (existing.length) {
      // Pre-seeded subset (verified modal samples): keep it, generate the rest.
      const seeded = new Set(
        existing.map(
          (q) => (q as { sourceQuestionId?: unknown }).sourceQuestionId,
        ),
      );
      try {
        keep(
          validateVariant(
            { questions: existing },
            sources.filter((s) => seeded.has(s.id)),
          ),
          parseReviews(row.validation),
        );
      } catch {
        latest.clear();
        accepted.clear();
        pendingVerify.clear();
      }
      for (const s of sources) if (!latest.has(s.id)) toGenerate.add(s.id);
    } else {
      const prior = parseQuestions(revisedFrom?.questions);
      let priorQuestions: VariantQuestion[] | null = null;
      try {
        if (prior.length)
          priorQuestions = validateVariant({ questions: prior }, sources);
      } catch {
        priorQuestions = null;
      }
      if (questionFeedback?.length) {
        for (const f of questionFeedback)
          if (sources.some((s) => s.id === f.sourceQuestionId))
            reasons.set(f.sourceQuestionId, f.reason);
      }
      if (questionFeedback?.length && priorQuestions) {
        // Selective revision: unflagged questions carry over unchanged.
        const priorReviews = parseReviews(revisedFrom?.validation);
        for (const q of priorQuestions) {
          if (reasons.has(q.sourceQuestionId)) {
            toGenerate.add(q.sourceQuestionId);
            replacing.push(q);
          } else keep([q], priorReviews);
        }
      } else {
        for (const s of sources) toGenerate.add(s.id);
        if (priorQuestions && reasons.size)
          replacing.push(
            ...priorQuestions.filter((q) => reasons.has(q.sourceQuestionId)),
          );
      }
      if (row.feedback) {
        feedback = row.feedback;
        previousDraft = parseQuestions(revisedFrom?.questions);
      }
    }

    const rejections: string[] = [];
    // Drafts reach the teacher only after passing every check. Rejected
    // questions are regenerated, with the reasons fed back, up to the attempt
    // cap — verified siblings are kept. Provider/transport errors fail at once
    // (the request gate already retried them), and teacher-edited drafts are
    // re-verified, never replaced.
    for (let round = 1; ; round++) {
      attempts++;
      const problems: string[] = [];
      if (toGenerate.size) {
        const genSources = sources.filter((s) => toGenerate.has(s.id));
        const genIds = new Set(genSources.map((s) => s.id));
        try {
          const previous = [
            ...(await previousQuestions(row.quizId, row.id)),
            ...replacing,
          ];
          const generated = await generateCandidates(
            call,
            {
              seed: row.id,
              variation,
              sources: genSources,
              objectives: objectives.filter((o) =>
                genIds.has(o.sourceQuestionId),
              ),
              rejections,
              feedback,
              previousDraft,
              reasons,
              replacing,
              partial: genSources.length < sources.length,
            },
            previous,
          );
          const others = [...sources, ...previous];
          for (const q of generated) {
            const source = genSources.find((s) => s.id === q.sourceQuestionId)!;
            latest.set(q.sourceQuestionId, q);
            const problem = qualityProblem(q, source, variation, others);
            if (problem) problems.push(problem);
            else {
              toGenerate.delete(q.sourceQuestionId);
              pendingVerify.add(q.sourceQuestionId);
            }
          }
        } catch (error) {
          if (!(error instanceof RejectedCandidate)) throw error;
          problems.push(error.message);
        }
      }
      lastCandidate = JSON.stringify(merged());
      const saved = await write({
        questions: lastCandidate,
        validation: accepted.size ? JSON.stringify(acceptedReviews()) : null,
        attempts,
        completedCount: accepted.size,
        totalCount: sources.length,
      });
      if (!saved) return;

      if (pendingVerify.size) {
        const candidates = sources
          .filter((s) => pendingVerify.has(s.id))
          .map((s) => latest.get(s.id)!);
        const ids = new Set(candidates.map((q) => q.sourceQuestionId));
        const verdicts = await verifyEach(
          call,
          candidates,
          sources.filter((s) => ids.has(s.id)),
          objectives.filter((o) => ids.has(o.sourceQuestionId)),
        );
        for (const q of candidates) {
          const verdict = verdicts.get(q.sourceQuestionId)!;
          pendingVerify.delete(q.sourceQuestionId);
          if (verdict.ok) accepted.set(q.sourceQuestionId, verdict.review);
          else {
            problems.push(verdict.error);
            if (!row.teacherEdited) toGenerate.add(q.sourceQuestionId);
          }
        }
      }

      if (accepted.size === sources.length) {
        const done = await write({
          status: "REVIEW",
          questions: JSON.stringify(merged()),
          validation: JSON.stringify(acceptedReviews()),
          aiModel,
          aiTokens: tokens,
          attempts,
          completedCount: sources.length,
          totalCount: sources.length,
          leaseToken: null,
          error: null,
        });
        if (!done) return;
        finalStatus = "REVIEW";
        return;
      }
      if (row.teacherEdited)
        throw new Error(problems[0] ?? "Verification failed.");
      if (round >= MAX_GENERATION_ATTEMPTS)
        throw new RejectedCandidate(problems.at(-1) ?? "Verification failed.");
      rejections.push(...problems.map((p) => p.slice(0, 500)));
      if (accepted.size)
        await write({
          validation: JSON.stringify(acceptedReviews()),
          completedCount: accepted.size,
        });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Generation failed";
    const failed = await write({
      status: "FAILED",
      questions: lastCandidate,
      validation: accepted.size
        ? JSON.stringify(acceptedReviews())
        : row.validation,
      attempts,
      aiTokens: tokens,
      completedCount: accepted.size,
      ...(sources.length ? { totalCount: sources.length } : {}),
      leaseToken: null,
      error: (error instanceof RejectedCandidate && !row.teacherEdited
        ? `No draft passed verification after ${MAX_GENERATION_ATTEMPTS} attempts. Last problem: ${message}`
        : message
      ).slice(0, 3000),
    }).catch(() => false);
    if (failed) finalStatus = "FAILED";
  } finally {
    clearInterval(heartbeat);
    if (finalStatus) {
      await logSystemEvent({
        category: "WORKER",
        type:
          finalStatus === "REVIEW"
            ? "VARIANT_GENERATION_COMPLETED"
            : "VARIANT_GENERATION_FAILED",
        severity: finalStatus === "REVIEW" ? "INFO" : "WARNING",
        message:
          finalStatus === "REVIEW"
            ? `Alternative quiz version ${versionId} is ready for review.`
            : `Alternative quiz version ${versionId} failed generation.`,
        metadata: {
          versionId,
          quizId: row.quizId,
          batchId: row.batchId,
          variation: row.variation,
          attempts,
          tokens,
          aiModel,
        },
      });
      if (row.batchId) {
        try {
          await notifyVariantBatchIfComplete(row.batchId);
        } catch (error) {
          console.error(
            "[quiz-variants] batch notification failed:",
            errorMessage(error),
          );
        }
      }
    }
  }
}

/** A GENERATING draft whose heartbeat is older than this is presumed dead. */
export const VARIANT_STALE_MS = 20 * 60_000;
/** A QUEUED draft untouched this long may have lost its queue job. */
export const VARIANT_ORPHAN_MS = 15 * 60_000;

/**
 * Worker crash recovery. Only drafts whose worker stopped heartbeating are
 * failed — a draft waiting in a busy queue is never failed for its age; it is
 * re-enqueued instead (duplicate jobs are harmless: the claim is atomic).
 */
export async function sweepStaleQuizVariants(
  enqueue: (versionId: string) => void,
  now: Date = new Date(),
): Promise<{ failed: number; requeued: number }> {
  const staleCutoff = new Date(now.getTime() - VARIANT_STALE_MS);
  const stale = await prisma.quizPracticeVersion.findMany({
    where: {
      status: "GENERATING",
      OR: [
        { heartbeatAt: { lt: staleCutoff } },
        { heartbeatAt: null, updatedAt: { lt: staleCutoff } },
      ],
    },
    select: { id: true, batchId: true, updatedAt: true },
    take: 200,
  });
  let failed = 0;
  const batches = new Set<string>();
  for (const row of stale) {
    const changed = await prisma.quizPracticeVersion.updateMany({
      where: { id: row.id, status: "GENERATING", updatedAt: row.updatedAt },
      data: {
        status: "FAILED",
        leaseToken: null,
        error:
          "Generation stopped responding (the worker restarted or timed out). Retry this version.",
      },
    });
    failed += changed.count;
    if (changed.count && row.batchId) batches.add(row.batchId);
  }
  for (const batchId of batches) {
    try {
      await notifyVariantBatchIfComplete(batchId, now);
    } catch (error) {
      console.error(
        "[quiz-variants] batch notification failed:",
        errorMessage(error),
      );
    }
  }

  const orphans = await prisma.quizPracticeVersion.findMany({
    where: {
      status: "QUEUED",
      updatedAt: { lt: new Date(now.getTime() - VARIANT_ORPHAN_MS) },
    },
    select: { id: true, updatedAt: true },
    orderBy: { updatedAt: "asc" },
    take: 200,
  });
  let requeued = 0;
  for (const row of orphans) {
    // Touch the row so the next sweep waits another window before re-enqueueing.
    const touched = await prisma.quizPracticeVersion.updateMany({
      where: { id: row.id, status: "QUEUED", updatedAt: row.updatedAt },
      data: { updatedAt: now },
    });
    if (!touched.count) continue;
    try {
      enqueue(row.id);
      requeued++;
    } catch (error) {
      console.error("[quiz-variants] re-enqueue failed:", errorMessage(error));
    }
  }
  return { failed, requeued };
}
