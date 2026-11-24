// System-managed automatic distractor labeling & key-point caching for Wrong
// Answer Coach. Zero teacher approval required:
// - Uses the admin-managed Misconception catalog (`getActiveMisconceptions`).
// - Uses OpenAI's Decisions API (`POST /v1/decisions`) to batch-label all wrong
//   options of a question or QuizPracticeVersion in a single fast request, with
//   a fallback to `quiz_variants` structured JSON if Decisions is unassigned.
// - Auto-assembles 2–3 key points from existing Question feedback and
//   QuizPracticeVersion objectives/solutions.

import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import {
  createOpenAIClient,
  resolveProvider,
  thinkingParams,
  type ResolvedProvider,
} from "./ai-provider";
import { createDecisions } from "./ai-decisions";
import {
  streamJsonCompletion,
  streamOptionsFor,
  transportFor,
} from "./ai-streaming";
import {
  getActiveMisconceptions,
  type MisconceptionCatalogEntry,
} from "./misconception-labeling";
import { fenceUntrusted, UNTRUSTED_CONTENT_RULE } from "./guardrail-fence";
import {
  computeQuestionSourceHash,
  isSupportedCoachQuestionShape,
} from "./wrong-answer-coach-rules";
import type { CoachOptionLabel } from "./wrong-answer-coach-types";
import type { VariantQuestion } from "./quiz-variants";
import { logSystemEvent } from "./system-log";
import { errorMessage } from "./errors";

const NO_LABEL_CHOICE = "no_label";
const MAX_DECISIONS_QUESTIONS_PER_BATCH = 200;

interface DistractorToLabel {
  key: string; // unique per batch, e.g. "q0_o1"
  questionText: string;
  correctOptionText: string;
  wrongOptionText: string;
}

interface LabeledDistractor {
  code: string | null;
  confidence: number | null;
}

/**
 * Batch-label wrong options against the active Misconception catalog using
 * POST /v1/decisions (up to 200 wrong options in one request!).
 */
async function labelDistractorsViaDecisions(
  provider: ResolvedProvider,
  items: DistractorToLabel[],
  catalog: MisconceptionCatalogEntry[],
): Promise<Map<string, LabeledDistractor>> {
  const result = new Map<string, LabeledDistractor>();
  if (items.length === 0) return result;
  if (catalog.length === 0) {
    for (const item of items)
      result.set(item.key, { code: null, confidence: null });
    return result;
  }

  const catalogCodes = catalog.map((m) => m.misconceptionId);
  const choices = [NO_LABEL_CHOICE, ...catalogCodes];
  const catalogBlock = catalog
    .map((m) => `- ${m.misconceptionId}: ${m.statement}`)
    .join("\n");

  for (let i = 0; i < items.length; i += MAX_DECISIONS_QUESTIONS_PER_BATCH) {
    const batch = items.slice(i, i + MAX_DECISIONS_QUESTIONS_PER_BATCH);
    const response = await createDecisions(provider, {
      model: provider.model,
      input: [
        UNTRUSTED_CONTENT_RULE,
        "",
        "Physics misconception catalog:",
        catalogBlock,
      ].join("\n"),
      questions: batch.map((item) => ({
        name: item.key,
        type: "choice" as const,
        instructions: [
          "Which single catalog misconception best explains why a student would pick this wrong option?",
          `Choose '${NO_LABEL_CHOICE}' if the option only reflects an arithmetic/reading error or matches none of the listed misconceptions.`,
          fenceUntrusted(
            "question option",
            `Question: ${item.questionText}\nCorrect answer: ${item.correctOptionText}\nWrong option: ${item.wrongOptionText}`,
          ),
        ].join("\n"),
        choices,
      })),
      store: false,
    });

    const allowedSet = new Set(catalogCodes);
    for (const ans of response.answers) {
      if (ans.type !== "choice") continue;
      if (ans.choice !== NO_LABEL_CHOICE && !allowedSet.has(ans.choice)) {
        continue; // Out-of-set choice; caught below so missing evidence never becomes valid null.
      }
      const code = ans.choice === NO_LABEL_CHOICE ? null : ans.choice;
      result.set(ans.name, { code, confidence: ans.confidence });
    }
  }

  const missingKeys = items
    .map((item) => item.key)
    .filter((key) => !result.has(key));
  if (missingKeys.length > 0) {
    throw new Error(
      `Decisions API batch labeling omitted or returned invalid choices for ${missingKeys.length} distractor(s).`,
    );
  }
  return result;
}

/**
 * Fallback structured-JSON distractor labeler when `wrong_answer_coach_classify`
 * (Decisions API) is not assigned yet. Uses `quiz_variants` or `recommendation`.
 */
async function labelDistractorsViaStructuredJson(
  provider: ResolvedProvider,
  items: DistractorToLabel[],
  catalog: MisconceptionCatalogEntry[],
): Promise<Map<string, LabeledDistractor>> {
  const result = new Map<string, LabeledDistractor>();
  if (items.length === 0 || catalog.length === 0) {
    for (const item of items)
      result.set(item.key, { code: null, confidence: null });
    return result;
  }

  const client = await createOpenAIClient(provider);
  const allowedCodes = catalog.map((m) => m.misconceptionId);
  const allowedSet = new Set(allowedCodes);

  const schema = {
    name: "distractor_misconception_labels",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        labels: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: { type: "string" },
              misconception_code: {
                anyOf: [
                  { type: "string", enum: allowedCodes },
                  { type: "null" },
                ],
              },
            },
            required: ["key", "misconception_code"],
          },
        },
      },
      required: ["labels"],
    },
  };

  const prompt = [
    "Map each wrong physics answer option to the single catalog misconception code that best explains choosing it, or null if none applies.",
    UNTRUSTED_CONTENT_RULE,
    "",
    "Catalog:",
    ...catalog.map((m) => `- ${m.misconceptionId}: ${m.statement}`),
    "",
    "Wrong options to label:",
    fenceUntrusted(
      "options",
      items
        .map(
          (it) =>
            `[${it.key}] Q: ${it.questionText} | Correct: ${it.correctOptionText} | Wrong: ${it.wrongOptionText}`,
        )
        .join("\n"),
    ),
  ].join("\n");

  const { value } = await streamJsonCompletion<{
    labels: Array<{ key: string; misconception_code: string | null }>;
  }>(
    client,
    {
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      ...thinkingParams(provider),
    },
    schema,
    streamOptionsFor(transportFor(provider), {
      requestOptions: { maxRetries: 0 },
    }),
  );

  for (const row of value?.labels ?? []) {
    const code =
      typeof row.misconception_code === "string" &&
      allowedSet.has(row.misconception_code)
        ? row.misconception_code
        : null;
    result.set(row.key, { code, confidence: null });
  }
  for (const item of items) {
    if (!result.has(item.key)) {
      result.set(item.key, { code: null, confidence: null });
    }
  }
  return result;
}

async function resolveLabelingProvider(): Promise<{
  provider: ResolvedProvider;
  mode: "decisions" | "json";
} | null> {
  const decisionsProvider = await resolveProvider(
    "wrong_answer_coach_classify",
  );
  if (decisionsProvider) {
    return { provider: decisionsProvider, mode: "decisions" };
  }
  const fallback =
    (await resolveProvider("quiz_variants")) ??
    (await resolveProvider("recommendation"));
  if (fallback) {
    return { provider: fallback, mode: "json" };
  }
  return null;
}

async function runBatchDistractorLabeling(
  items: DistractorToLabel[],
  catalog: MisconceptionCatalogEntry[],
): Promise<{
  labels: Map<string, LabeledDistractor>;
  model: string | null;
  providerType: string | null;
  totalMs: number;
}> {
  const startedAt = Date.now();
  const resolved = await resolveLabelingProvider();
  if (!resolved) {
    throw new Error(
      "No AI provider configured for wrong_answer_coach_classify (or fallback) to label distractors.",
    );
  }

  const labels =
    resolved.mode === "decisions"
      ? await labelDistractorsViaDecisions(resolved.provider, items, catalog)
      : await labelDistractorsViaStructuredJson(
          resolved.provider,
          items,
          catalog,
        );

  return {
    labels,
    model: resolved.provider.model,
    providerType: resolved.provider.providerType,
    totalMs: Math.max(0, Date.now() - startedAt),
  };
}

/**
 * Derive 2–3 concise key ideas from existing system data (no teacher approval):
 * Question.feedbackGeneral / feedbackCorrect + QuizPracticeVersion objectives & solutions.
 */
export function deriveKeyPointsFromExistingContent(input: {
  questionText: string;
  correctOptionText: string;
  feedbackGeneral?: string | null;
  feedbackCorrect?: string | null;
  variantObjectives?: string[];
  variantSolutions?: string[];
}): string[] {
  const candidates: string[] = [];
  const pushSentences = (raw: string | null | undefined) => {
    if (!raw) return;
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.toLowerCase() === "source answer key") return;
    const parts = cleaned
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 12 && s.length <= 240);
    for (const part of parts) {
      if (candidates.length >= 3) break;
      if (!candidates.some((c) => c.toLowerCase() === part.toLowerCase())) {
        candidates.push(part);
      }
    }
  };

  pushSentences(input.feedbackCorrect);
  pushSentences(input.feedbackGeneral);
  for (const sol of input.variantSolutions ?? []) {
    if (candidates.length >= 3) break;
    pushSentences(sol);
  }
  for (const obj of input.variantObjectives ?? []) {
    if (candidates.length >= 3) break;
    if (
      !obj.toLowerCase().startsWith("preserve the original learning objective")
    ) {
      pushSentences(obj);
    }
  }

  if (candidates.length === 0) {
    candidates.push(
      `Correct relationship for this scenario leads to: ${input.correctOptionText}.`,
    );
  }
  return candidates.slice(0, 3);
}

/**
 * Auto-label every wrong option on a QuizPracticeVersion's SINGLE_SELECT
 * questions against the active Misconception catalog. Purely additive on
 * VariantQuestion.options[].misconceptionCode — zero teacher approval gate.
 */
export async function labelVariantQuestions(
  questions: VariantQuestion[],
): Promise<{ questions: VariantQuestion[]; labeled: boolean }> {
  const catalog = await getActiveMisconceptions();
  const items: DistractorToLabel[] = [];

  for (const q of questions) {
    if (q.answerMode !== "SINGLE_SELECT") continue;
    const correct = q.options.find((o) => o.isCorrect);
    if (!correct) continue;
    for (const opt of q.options) {
      if (opt.isCorrect) continue;
      items.push({
        key: `${q.id}::${opt.id}`,
        questionText: q.text,
        correctOptionText: correct.text,
        wrongOptionText: opt.text,
      });
    }
  }

  if (items.length === 0) {
    return { questions, labeled: true };
  }
  if (catalog.length === 0) {
    // Do NOT stamp coachLabeledAt when the misconception catalog is empty;
    // retry automatically once misconceptions are seeded.
    return { questions, labeled: false };
  }

  const { labels } = await runBatchDistractorLabeling(items, catalog);

  const enriched: VariantQuestion[] = questions.map((q) => {
    if (q.answerMode !== "SINGLE_SELECT") return q;
    return {
      ...q,
      options: q.options.map((opt) => {
        if (opt.isCorrect) return { ...opt, misconceptionCode: null };
        const found = labels.get(`${q.id}::${opt.id}`);
        return { ...opt, misconceptionCode: found?.code ?? null };
      }),
    };
  });

  return { questions: enriched, labeled: true };
}

/**
 * Ensure every eligible SINGLE_SELECT question in a quiz has up-to-date
 * QuestionCoachMetadata (auto-labeled wrong options + cached key points).
 */
const LABEL_BACKOFF_MS = 15 * 60_000;

export async function ensureQuizCoachMetadata(
  quizId: string,
  options: { isSweep?: boolean } = {},
): Promise<void> {
  const [questions, publishedVersions, catalog] = await Promise.all([
    prisma.question.findMany({
      where: { quizId },
      include: {
        options: { orderBy: { id: "asc" } },
        coachMetadata: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.quizPracticeVersion.findMany({
      where: { quizId, status: { in: ["REVIEW", "PUBLISHED"] } },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { objectives: true, questions: true },
    }),
    getActiveMisconceptions(),
  ]);

  if (catalog.length === 0) {
    return;
  }

  const backoffCutoff = new Date(Date.now() - LABEL_BACKOFF_MS);
  const toLabel: Array<{
    question: (typeof questions)[number];
    sourceHash: string;
    runId: string;
  }> = [];

  for (const q of questions) {
    const shape = isSupportedCoachQuestionShape({
      answerMode: q.answerMode,
      figureStorageKey: q.figureStorageKey,
      options: q.options,
    });
    if (!shape.ok) continue;

    const sourceHash = computeQuestionSourceHash({
      text: q.text,
      answerMode: q.answerMode,
      figureStorageKey: q.figureStorageKey,
      figureAlt: q.figureAlt,
      options: q.options,
    });

    const existing = q.coachMetadata;
    if (
      existing &&
      existing.status === "READY" &&
      existing.sourceHash === sourceHash
    ) {
      continue;
    }
    // Never clobber an active PROCESSING claim within the lease window.
    if (
      existing &&
      existing.status === "PROCESSING" &&
      existing.updatedAt >= backoffCutoff
    ) {
      continue;
    }
    // During periodic sweeps, back off FAILED rows for 15 minutes unless content changed.
    if (
      options.isSweep &&
      existing &&
      existing.status === "FAILED" &&
      existing.sourceHash === sourceHash &&
      existing.updatedAt >= backoffCutoff
    ) {
      continue;
    }

    const runId = randomUUID();
    if (!existing) {
      try {
        await prisma.questionCoachMetadata.create({
          data: {
            questionId: q.id,
            status: "PROCESSING",
            sourceHash,
            runId,
          },
        });
      } catch {
        continue; // Concurrent creator claimed it
      }
    } else {
      const claimed = await prisma.questionCoachMetadata.updateMany({
        where: {
          questionId: q.id,
          OR: [
            { status: { not: "PROCESSING" } },
            { updatedAt: { lt: backoffCutoff } },
          ],
        },
        data: {
          status: "PROCESSING",
          sourceHash,
          runId,
          errorMessage: null,
        },
      });
      if (claimed.count !== 1) continue;
    }
    toLabel.push({ question: q, sourceHash, runId });
  }

  if (toLabel.length === 0) return;

  const items: DistractorToLabel[] = [];
  for (const entry of toLabel) {
    const correct = entry.question.options.find((o) => o.isCorrect);
    if (!correct) continue;
    for (const opt of entry.question.options) {
      if (opt.isCorrect) continue;
      items.push({
        key: `${entry.question.id}::${opt.id}`,
        questionText: entry.question.text,
        correctOptionText: correct.text,
        wrongOptionText: opt.text,
      });
    }
  }

  try {
    const { labels, model, providerType, totalMs } =
      await runBatchDistractorLabeling(items, catalog);

    for (const entry of toLabel) {
      const q = entry.question;
      const correct = q.options.find((o) => o.isCorrect)!;
      const optionLabels: CoachOptionLabel[] = q.options.map((opt) => {
        if (opt.isCorrect) {
          return {
            optionId: opt.id,
            optionText: opt.text,
            isCorrect: true,
            misconceptionCode: null,
            confidence: null,
          };
        }
        const labeled = labels.get(`${q.id}::${opt.id}`);
        return {
          optionId: opt.id,
          optionText: opt.text,
          isCorrect: false,
          misconceptionCode: labeled?.code ?? null,
          confidence: labeled?.confidence ?? null,
        };
      });

      const relevantCodes = [
        ...new Set(
          optionLabels
            .map((l) => l.misconceptionCode)
            .filter((c): c is string => Boolean(c)),
        ),
      ];

      // Gather existing objectives & solutions for this question from variants.
      const variantObjectives: string[] = [];
      const variantSolutions: string[] = [];
      for (const v of publishedVersions) {
        try {
          const objs = JSON.parse(v.objectives) as Array<{
            sourceQuestionId: string;
            objective: string;
          }>;
          const matchObj = objs.find((o) => o.sourceQuestionId === q.id);
          if (matchObj?.objective) variantObjectives.push(matchObj.objective);
          const vqs = JSON.parse(v.questions) as VariantQuestion[];
          const matchQ = vqs.find((vq) => vq.sourceQuestionId === q.id);
          if (matchQ?.solution) variantSolutions.push(matchQ.solution);
        } catch {
          // ignore malformed historical JSON
        }
      }

      const keyPoints = deriveKeyPointsFromExistingContent({
        questionText: q.text,
        correctOptionText: correct.text,
        feedbackGeneral: q.feedbackGeneral,
        feedbackCorrect: q.feedbackCorrect,
        variantObjectives,
        variantSolutions,
      });

      // Fence on runId + sourceHash so concurrent edits are never overwritten.
      await prisma.questionCoachMetadata.updateMany({
        where: {
          questionId: q.id,
          runId: entry.runId,
          sourceHash: entry.sourceHash,
        },
        data: {
          status: "READY",
          optionLabelsJson: JSON.stringify(optionLabels),
          keyPointsJson: JSON.stringify(keyPoints),
          relevantMisconceptionsJson: JSON.stringify(relevantCodes),
          aiModel: model,
          aiProvider: providerType,
          aiTotalMs: totalMs,
          labeledAt: new Date(),
          errorMessage: null,
        },
      });
    }
  } catch (err) {
    const msg = errorMessage(err).slice(0, 1000);
    for (const entry of toLabel) {
      await prisma.questionCoachMetadata.updateMany({
        where: {
          questionId: entry.question.id,
          runId: entry.runId,
          sourceHash: entry.sourceHash,
        },
        data: {
          status: "FAILED",
          errorMessage: msg,
        },
      });
    }
    await logSystemEvent({
      category: "WORKER",
      type: "COACH_AUTO_LABEL_FAILED",
      severity: "WARNING",
      message: `Coach metadata auto-labeling failed for quiz ${quizId}: ${msg}`,
      metadata: { quizId },
    });
  }
}

/**
 * Mark QuestionCoachMetadata PENDING inside a question-edit transaction when
 * the content-only sourceHash changed so the worker automatically re-labels it.
 */
export async function markQuestionCoachMetadataStale(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  questionId: string,
  newSourceHash: string,
): Promise<void> {
  const existing = await tx.questionCoachMetadata.findUnique({
    where: { questionId },
    select: { id: true, sourceHash: true },
  });
  if (!existing || existing.sourceHash === newSourceHash) return;

  await tx.questionCoachMetadata.update({
    where: { questionId },
    data: {
      status: "PENDING",
      sourceHash: newSourceHash,
      runId: null,
      labeledAt: null,
      errorMessage: null,
    },
  });
}

/**
 * Worker sweep: auto-label any PUBLISHED Coach-assigned QuizPracticeVersion
 * whose `coachLabeledAt` is null and any `PENDING` QuestionCoachMetadata rows.
 */
export async function sweepCoachAutoLabeling(): Promise<number> {
  let processed = 0;

  // 1. Backfill unlabeled PUBLISHED COACH_CHECK3 / COACH_HELDOUT variants.
  const unlabeledVariants = await prisma.quizPracticeVersion.findMany({
    where: {
      status: "PUBLISHED",
      coachRole: { in: ["COACH_CHECK3", "COACH_HELDOUT"] },
      coachLabeledAt: null,
    },
    take: 5,
    orderBy: { updatedAt: "asc" },
  });

  const touchedQuizIds = new Set<string>();
  for (const variant of unlabeledVariants) {
    try {
      const parsed = JSON.parse(variant.questions) as VariantQuestion[];
      const { questions, labeled } = await labelVariantQuestions(parsed);
      if (labeled) {
        await prisma.quizPracticeVersion.updateMany({
          where: { id: variant.id, coachLabeledAt: null },
          data: {
            questions: JSON.stringify(questions),
            coachLabeledAt: new Date(),
          },
        });
        touchedQuizIds.add(variant.quizId);
        processed += 1;
      }
    } catch (err) {
      await logSystemEvent({
        category: "WORKER",
        type: "COACH_VARIANT_LABEL_FAILED",
        severity: "WARNING",
        message: `Auto-labeling variant ${variant.id} failed: ${errorMessage(err)}`,
        metadata: { versionId: variant.id, quizId: variant.quizId },
      });
    }
  }

  // 2. Find quizzes with Coach-assigned variants or PENDING QuestionCoachMetadata.
  const pendingMeta = await prisma.questionCoachMetadata.findMany({
    where: { status: "PENDING" },
    select: { question: { select: { quizId: true } } },
    orderBy: { updatedAt: "asc" },
    take: 20,
  });
  for (const row of pendingMeta) {
    touchedQuizIds.add(row.question.quizId);
  }

  // Also sweep quizzes with published COACH_* variants whose questions lack READY metadata.
  const coachVariants = await prisma.quizPracticeVersion.findMany({
    where: {
      status: "PUBLISHED",
      coachRole: { in: ["COACH_CHECK3", "COACH_HELDOUT"] },
    },
    select: { quizId: true },
    orderBy: { updatedAt: "asc" },
    distinct: ["quizId"],
    take: 50,
  });
  for (const row of coachVariants) {
    touchedQuizIds.add(row.quizId);
  }

  // Reset stuck PROCESSING metadata older than 15 minutes back to PENDING.
  await prisma.questionCoachMetadata.updateMany({
    where: {
      status: "PROCESSING",
      updatedAt: { lt: new Date(Date.now() - LABEL_BACKOFF_MS) },
    },
    data: { status: "PENDING", runId: null },
  });

  for (const quizId of touchedQuizIds) {
    await ensureQuizCoachMetadata(quizId, { isSweep: true });
    processed += 1;
  }

  return processed;
}
