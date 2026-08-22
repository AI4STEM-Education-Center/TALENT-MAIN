// Impure orchestration for generating + persisting an ExamResult's AI content.
// Runs in the background worker (decoupled from the HTTP request, so generation
// completes even if the student navigates away) and is also used by the results
// API/page to re-presign stored recommendation images on read. All DB / LLM /
// S3 access is concentrated here; the pure transforms live in `exam-results.ts`.

import type OpenAI from "openai";
import { prisma } from "./prisma";
import { hasResearchConsent } from "./consent";
import {
  resolveProvider,
  createOpenAIClient,
  thinkingParams,
  type ResolvedProvider,
  type ThinkingParams,
} from "./ai-provider";
import { streamChatCompletion, streamJsonCompletion, aggregateMetrics, type AiCallMetrics } from "./ai-streaming";
import { retryWithExponentialBackoff } from "./retry";
import { signObjectReadUrl, getS3Config } from "./storage";
import { presignOptionImage, presignQuestionFigure } from "./question-figures";
import { buildQuizReviewPrompt, type ChatMessage } from "./chat-prompt";
import {
  MATERIAL_SELECTION_SCHEMA,
  PAGE_SELECTION_SCHEMA,
  buildMaterialSelectionPrompt,
  buildPageSelectionPrompt,
  resolveSelectedMaterial,
  dedupeSelectedMaterials,
  clampPageRange,
  type HolisticAttempt,
  type CatalogMaterial,
  type CatalogPage,
  type SelectedMaterial,
  type MaterialSelection,
  type PageSelection,
} from "./recommendation";
import {
  getActiveMisconceptions,
  extractIncorrectAnswerEvidence,
  buildMisconceptionLabelingPrompt,
  buildMisconceptionSchema,
  resolveLabeledMisconceptions,
  type MisconceptionLabeling,
} from "./misconception-labeling";
import {
  RESULT_STATUS,
  parseReviewSnapshot,
  parseStoredRecommendations,
  snapshotToHolisticInput,
  snapshotToSummaryAttempt,
  mapPresignedRecommendations,
  dedupeStoredSimulations,
  type ReviewSnapshot,
  type StoredRecommendation,
  type StoredRecommendations,
  type StoredSimulationRecommendation,
  type SimulationRecommendationView,
  type StoredMisconception,
  type StoredQuestionMisconceptions,
  type PresignedRecommendations,
  type StudentMistakeSource,
  type StudentMistakeView,
} from "./exam-results";

const SUMMARY_MAX_TOKENS = 500;
const MAX_PAGES_PER_REC = 5;
const MAX_SIMULATION_RECS = 3;
const PROCESSED_STATUS = "SUCCESS";

type MaterialPageRow = {
  pageNumber: number;
  storageKey: string;
  needed: boolean | null;
  keyConcept: string | null;
  description: string | null;
};

type MaterialRow = {
  id: string;
  title: string | null;
  originalName: string;
  processingStatus: string;
  batchDescription: string | null;
  batchKeyConcepts: string;
  pages: MaterialPageRow[];
};

type ExamResultRow = {
  id: string;
  studentId: string;
  classId: string;
  score: number;
  completedAt: Date;
  className: string;
  topicName: string;
  quizName: string;
  reviewSnapshot: string;
  summaryStatus: string;
  recommendationsStatus: string;
};

function parseKeyConcepts(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function providerUsable(provider: ResolvedProvider | null): provider is ResolvedProvider {
  if (!provider) return false;
  if (provider.providerType !== "local" && !provider.apiKey) return false;
  if ((provider.providerType === "local" || provider.providerType === "cloudflare") && !provider.baseUrl) {
    return false;
  }
  return true;
}

/**
 * Streaming chat completion. Mirrors the chat route's token-cap
 * (`max_completion_tokens` for cloud vs `max_tokens` for local), service_tier
 * gating, and thinking level so stored summaries match the chatbot's output
 * characteristics. Returns the text plus its TTFT/token metrics.
 */
async function runChatCompletionText(
  provider: ResolvedProvider,
  messages: ChatMessage[],
  maxTokens: number,
  onContent?: (text: string, delta: string) => void | Promise<void>
): Promise<{ text: string; metrics: AiCallMetrics }> {
  const client = await createOpenAIClient(provider);
  const isLocal = provider.providerType === "local";
  const serviceTier = provider.serviceTier;
  const tierActive =
    !isLocal && (serviceTier === "auto" || serviceTier === "default" || serviceTier === "flex");

  return streamChatCompletion(
    client,
    {
      model: provider.model,
      messages: messages as never,
      max_completion_tokens: !isLocal ? maxTokens : undefined,
      max_tokens: isLocal ? maxTokens : undefined,
      service_tier: tierActive ? (serviceTier as never) : undefined,
      // Empty unless an admin pinned a thinking level on the assigned model.
      ...thinkingParams(provider),
    },
    {
      includeUsage: !isLocal,
      requestOptions: { maxRetries: isLocal ? 0 : 3 },
      onContent,
    }
  );
}

/**
 * Who served a section's calls, persisted beside the model rather than folded
 * into it. Sections written before these columns existed keep the older
 * "providerType/model" label in `*AiModel` and are never rewritten.
 */
const providerLabels = (provider: ResolvedProvider) => ({
  providerType: provider.providerType,
  serviceTier: provider.serviceTier,
  thinkingLevel: provider.thinkingLevel,
});

/** Run one streamed structured (strict JSON schema) step, returning value + metrics. */
async function runStructuredStep<T>(
  client: OpenAI,
  model: string,
  prompt: string,
  schemaName: string,
  schema: object,
  thinking: ThinkingParams,
  isLocal: boolean
): Promise<{ value: T; metrics: AiCallMetrics }> {
  return streamJsonCompletion<T>(
    client,
    { model, messages: [{ role: "user", content: prompt }], ...thinking },
    { name: schemaName, schema: schema as Record<string, unknown>, strict: true },
    { includeUsage: !isLocal, requestOptions: { maxRetries: isLocal ? 0 : 3 } }
  );
}

/**
 * Step 2 for one chosen material: pick a focused 0-5 page range within it,
 * returning storageKeys (not URLs) plus the TTFT/token metrics. Returns a null
 * recommendation when the model finds no relevant pages (has_relevant_pages
 * false) or the material has no usable pages. `materialReason` is the step-1
 * reasoning, used as a fallback when the page step returns no reasoning text.
 */
async function selectPagesForMaterial(
  client: OpenAI,
  model: string,
  attempt: HolisticAttempt,
  chosen: CatalogMaterial,
  material: MaterialRow,
  materialReason: string,
  thinking: ThinkingParams,
  isLocal: boolean
): Promise<{ recommendation: StoredRecommendation | null; metrics: AiCallMetrics[] }> {
  const metrics: AiCallMetrics[] = [];

  const teachingPages = material.pages.filter((p) => p.needed !== false);
  const usablePages = teachingPages.length > 0 ? teachingPages : material.pages;
  if (usablePages.length === 0) return { recommendation: null, metrics };

  const catalogPages: CatalogPage[] = usablePages.map((p) => ({
    pageNumber: p.pageNumber,
    keyConcept: p.keyConcept ?? "",
    description: p.description ?? "",
  }));

  const { value: pageSelection, metrics: m } = await runStructuredStep<PageSelection>(
    client,
    model,
    buildPageSelectionPrompt(attempt, chosen.title, catalogPages),
    "page_selection",
    PAGE_SELECTION_SCHEMA,
    thinking,
    isLocal
  );
  metrics.push(m);

  // The model decided no pages of this material are worth recommending (a soft
  // 0-page outcome): skip it entirely.
  if (!pageSelection.has_relevant_pages) return { recommendation: null, metrics };

  const range = clampPageRange(
    pageSelection.start_page,
    pageSelection.end_page,
    usablePages.map((p) => p.pageNumber)
  );
  if (!range) return { recommendation: null, metrics };

  const selectedPages = usablePages
    .filter((p) => p.pageNumber >= range.start && p.pageNumber <= range.end)
    .slice(0, MAX_PAGES_PER_REC);
  if (selectedPages.length === 0) return { recommendation: null, metrics };

  return {
    recommendation: {
      materialTitle: chosen.title,
      pageRange: range,
      reason: pageSelection.reasoning?.trim() || materialReason,
      pages: selectedPages.map((p) => ({ pageNumber: p.pageNumber, storageKey: p.storageKey })),
    },
    metrics,
  };
}

/**
 * Label each incorrect answer with 1-3 catalog misconceptions. Independent of
 * study-material availability — it only
 * needs a usable provider, a non-empty active catalog, and at least one
 * incorrect answer. Any failure (empty catalog, no incorrect answers, LLM
 * error) fails the recommendation section closed so an attempt is never marked
 * READY with an unlabeled quiz error.
 */
async function labelMisconceptions(
  client: OpenAI,
  model: string,
  thinking: ThinkingParams,
  isLocal: boolean,
  snapshot: ReviewSnapshot
): Promise<{ errorMisconceptions: StoredQuestionMisconceptions[]; metrics: AiCallMetrics[] }> {
  const catalog = await getActiveMisconceptions();
  if (catalog.length === 0) {
    throw new Error("The active misconception catalog is empty.");
  }

  const incorrect = extractIncorrectAnswerEvidence(snapshot);
  if (incorrect.length === 0) return { errorMisconceptions: [], metrics: [] };

  const ids = catalog.map((m) => m.misconceptionId);
  const labeled = await Promise.all(
    incorrect.map(async (error) => {
      const { value, metrics } = await retryWithExponentialBackoff(() =>
        streamJsonCompletion<MisconceptionLabeling>(
          client,
          {
            model,
            messages: [
              { role: "user", content: buildMisconceptionLabelingPrompt([error], catalog) },
            ],
            ...thinking,
          },
          { name: "misconception_labeling", schema: buildMisconceptionSchema(ids), strict: true },
          { includeUsage: !isLocal, requestOptions: { maxRetries: isLocal ? 0 : 3 } }
        )
      );
      const misconceptions: StoredMisconception[] = resolveLabeledMisconceptions(
        value.misconception_ids ?? [],
        catalog
      );
      if (misconceptions.length === 0) {
        throw new Error(
          `No valid misconception was returned for question index ${error.questionIndex}.`
        );
      }
      return {
        label: {
          questionId: error.questionId,
          questionIndex: error.questionIndex,
          misconceptions,
        },
        metrics,
      };
    })
  );
  return {
    errorMisconceptions: labeled.map((result) => result.label),
    metrics: labeled.map((result) => result.metrics),
  };
}

/**
 * Deterministically pick interactive simulations for the attempt: the READY
 * simulations of the questions answered incorrectly, in attempt order, deduped
 * by artifact (triage may point several same-topic questions at one shared
 * artifact) and capped. No LLM involved — the simulations were already
 * generated (and teacher-reviewed) against the quiz's questions, and they
 * contain no question details by construction, so surfacing them during blind
 * review leaks nothing beyond the broad topics the student should revisit —
 * the same signal the material recommendations already give.
 */
async function collectSimulationRecommendations(
  snapshot: ReviewSnapshot
): Promise<StoredSimulationRecommendation[]> {
  const incorrectIds = snapshot.questions
    .filter((q) => !q.isCorrect && typeof q.questionId === "string")
    .map((q) => q.questionId as string);
  if (incorrectIds.length === 0) return [];

  const sims = await prisma.questionSimulation.findMany({
    where: { questionId: { in: incorrectIds }, status: "READY", storageKey: { not: null } },
  });
  if (sims.length === 0) return [];

  // Preserve attempt order, dedupe by artifact key AND by display identity —
  // two questions can carry independently-built artifacts (distinct
  // storageKeys) that still present as the same simulation to the student.
  const byQuestion = new Map(sims.map((s) => [s.questionId, s]));
  const seenArtifacts = new Set<string>();
  const picked: StoredSimulationRecommendation[] = [];
  for (const questionId of incorrectIds) {
    const sim = byQuestion.get(questionId);
    if (!sim) continue;
    const artifactKey = sim.storageKey ?? sim.id;
    if (seenArtifacts.has(artifactKey)) continue;
    seenArtifacts.add(artifactKey);
    picked.push({
      simulationId: sim.id,
      title: sim.title,
      topic: sim.topic,
      learningGoal: sim.learningGoal,
    });
  }
  return dedupeStoredSimulations(picked).slice(0, MAX_SIMULATION_RECS);
}

/** Generate the markdown summary from the durable review snapshot. */
async function generateSummary(
  examResult: ExamResultRow
): Promise<{
  summary: string;
  metrics: AiCallMetrics;
  providerType: string;
  serviceTier: string | null;
  thinkingLevel: string | null;
}> {
  const provider = await resolveProvider("description_generation");
  if (!providerUsable(provider)) {
    throw new Error("No usable AI provider configured for description_generation");
  }

  const snapshot = parseReviewSnapshot(examResult.reviewSnapshot);
  const attempt = snapshotToSummaryAttempt(snapshot, {
    score: examResult.score,
    completedAt: examResult.completedAt,
    className: examResult.className,
    topicName: examResult.topicName,
    quizName: examResult.quizName,
  });

  // Checkpoint the accumulated markdown while the model is still producing
  // tokens. The results stream reads these checkpoints, so the student starts
  // reading at TTFT instead of waiting for the full completion. Throttling
  // avoids turning every token delta into a SQLite write.
  let lastCheckpointAt = 0;
  const checkpoint = async (text: string) => {
    const now = Date.now();
    if (now - lastCheckpointAt < 150) return;
    lastCheckpointAt = now;
    try {
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: { summary: text },
      });
    } catch (err) {
      // A missed partial checkpoint is non-fatal; the final READY write below
      // remains authoritative.
      console.warn(`[ExamResults] Could not checkpoint summary ${examResult.id}:`, err);
    }
  };

  const { text, metrics } = await runChatCompletionText(
    provider,
    [{ role: "user", content: buildQuizReviewPrompt(attempt) }],
    SUMMARY_MAX_TOKENS,
    checkpoint
  );
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Model returned an empty summary");
  return { summary: trimmed, metrics, ...providerLabels(provider) };
}

/**
 * Generate HOLISTIC recommendations from the whole attempt + the class's
 * processed materials. Step 1 picks at most 3 materials across the entire
 * attempt; step 2 picks a focused 0-5 page range within each (skipping a
 * material the model deems irrelevant). Environment gaps (no provider / no
 * materials / no S3) and a perfect score yield an empty-but-terminal result
 * rather than an error. None of the generated reasons reveal which questions
 * were wrong (enforced by the prompts in recommendation.ts).
 */
async function generateRecommendations(
  examResult: ExamResultRow
): Promise<{
  stored: StoredRecommendations;
  metrics: AiCallMetrics | null;
  providerType: string | null;
  serviceTier: string | null;
  thinkingLevel: string | null;
  generationMs: number | null;
}> {
  const snapshot = parseReviewSnapshot(examResult.reviewSnapshot);
  const holistic = snapshotToHolisticInput(snapshot);
  // Nothing wrong (or an empty attempt) → no study recommendations needed.
  if (holistic.incorrectCount === 0) {
    return {
      stored: { items: [], truncated: false },
      metrics: null,
      providerType: null,
      serviceTier: null,
      thinkingLevel: null,
      generationMs: null,
    };
  }

  // Interactive simulations are picked deterministically (no LLM), so they
  // reach the student even when the chat provider is unassigned or down.
  const simulations = await collectSimulationRecommendations(snapshot);
  const withSims = (stored: StoredRecommendations): StoredRecommendations => ({
    ...stored,
    ...(simulations.length > 0 ? { simulations } : {}),
  });

  const provider = await resolveProvider("recommendation");
  if (!providerUsable(provider)) {
    return {
      stored: withSims({ items: [], truncated: false }),
      metrics: null,
      providerType: null,
      serviceTier: null,
      thinkingLevel: null,
      generationMs: null,
    };
  }

  const isLocal = provider.providerType === "local";
  const client = await createOpenAIClient(provider);
  // Threaded through every step below; empty unless the assigned model has a
  // thinking level pinned in AI config.
  const thinking = thinkingParams(provider);
  const allMetrics: AiCallMetrics[] = [];

  // Misconception labels are independent of study-material availability: run
  // them whenever there's a usable provider and incorrect answers, even when
  // no materials end up being recommended below (or S3 isn't configured at
  // all). A labeling failure never blocks the material recommendations.
  const { errorMisconceptions, metrics: labelMetrics } = await labelMisconceptions(
    client,
    provider.model,
    thinking,
    isLocal,
    snapshot
  );
  allMetrics.push(...labelMetrics);

  let items: StoredRecommendation[] = [];
  let truncated = false;

  let s3Available = true;
  try {
    getS3Config();
  } catch {
    s3Available = false;
  }

  if (s3Available) {
    const links = await prisma.materialClass.findMany({
      where: { classId: examResult.classId },
      select: {
        material: {
          select: {
            id: true,
            title: true,
            originalName: true,
            processingStatus: true,
            batchDescription: true,
            batchKeyConcepts: true,
            pages: {
              select: { pageNumber: true, storageKey: true, needed: true, keyConcept: true, description: true },
              orderBy: { pageNumber: "asc" },
            },
          },
        },
      },
    });

    const materials: MaterialRow[] = links.flatMap((l) => {
      const m = l.material;
      return m.processingStatus === PROCESSED_STATUS &&
        !!m.batchDescription?.trim() &&
        m.pages.length > 0
        ? [m]
        : [];
    });

    if (materials.length > 0) {
      const catalog: CatalogMaterial[] = materials.map((m, i) => ({
        index: i + 1,
        title: m.title?.trim() || m.originalName,
        description: m.batchDescription ?? "",
        keyConcepts: parseKeyConcepts(m.batchKeyConcepts),
      }));

      // Step 1 — one call selecting at most 3 materials across the whole attempt.
      const { value: materialSelection, metrics: mSel } = await runStructuredStep<MaterialSelection>(
        client,
        provider.model,
        buildMaterialSelectionPrompt(holistic, catalog),
        "material_selection",
        MATERIAL_SELECTION_SCHEMA,
        thinking,
        isLocal
      );
      allMetrics.push(mSel);

      const { kept, truncated: t } = dedupeSelectedMaterials(materialSelection.materials ?? [], catalog);
      truncated = t;

      // Step 2 — one page-selection call per chosen material (skipped when the
      // model finds no relevant pages). Run concurrently; failures drop that one.
      const results = await Promise.all(
        kept.map(async (sel: SelectedMaterial) => {
          const chosen = resolveSelectedMaterial(sel.material_index, catalog);
          const material = chosen ? materials[chosen.index - 1] : undefined;
          if (!chosen || !material) return { recommendation: null, metrics: [] as AiCallMetrics[] };
          try {
            return await selectPagesForMaterial(
              client,
              provider.model,
              holistic,
              chosen,
              material,
              sel.reasoning,
              thinking,
              isLocal
            );
          } catch (err) {
            console.error("[ExamResults] Failed to build a recommendation:", err);
            return { recommendation: null, metrics: [] as AiCallMetrics[] };
          }
        })
      );

      items = results.map((r) => r.recommendation).filter((r): r is StoredRecommendation => r !== null);
      allMetrics.push(...results.flatMap((r) => r.metrics));
    }
  }

  const metrics = aggregateMetrics(allMetrics);

  return {
    stored: withSims({
      items,
      truncated,
      ...(errorMisconceptions.length > 0 ? { errorMisconceptions } : {}),
    }),
    metrics,
    providerType: metrics ? provider.providerType : null,
    serviceTier: metrics ? provider.serviceTier : null,
    thinkingLevel: metrics ? provider.thinkingLevel : null,
    // Null unless every call that produced content actually streamed, so a
    // buffering gateway's flush time never gets shown as generation time.
    generationMs: metrics?.generationMs ?? null,
  };
}

/**
 * Generate + persist both AI sections of an ExamResult. Idempotent: a section
 * already READY is skipped, so Honker job redelivery (e.g. after a worker
 * restart) is safe. Each section moves PENDING/FAILED → GENERATING → READY/FAILED
 * independently; a failure in one never blocks the other.
 */
export async function generateExamResult(examResultId: string): Promise<void> {
  const examResult = (await prisma.examResult.findUnique({
    where: { id: examResultId },
  })) as ExamResultRow | null;
  if (!examResult) return;

  // These two sections are engagement/diagnostic telemetry layered on top of
  // grading, not grading itself — the score/correctCount/reviewSnapshot were
  // already computed and persisted before this job ever runs, independent of
  // consent. Gated per docs/plans/consent-compliance-plan.md §9: a
  // non-consenting student's attempt is graded exactly the same as anyone
  // else's, it just never gets an AI summary, study recommendations, or
  // misconception labels generated for it. "SKIPPED_NO_CONSENT" is distinct
  // from "FAILED" so it's never mistaken for a bug or retried.
  if (!(await hasResearchConsent(examResult.studentId))) {
    await prisma.examResult.updateMany({
      where: { id: examResult.id, summaryStatus: { not: RESULT_STATUS.READY } },
      data: { summaryStatus: "SKIPPED_NO_CONSENT" },
    });
    await prisma.examResult.updateMany({
      where: { id: examResult.id, recommendationsStatus: { not: RESULT_STATUS.READY } },
      data: { recommendationsStatus: "SKIPPED_NO_CONSENT" },
    });
    return;
  }

  const generateSummarySection = async () => {
    if (examResult.summaryStatus === RESULT_STATUS.READY) return;
    await prisma.examResult.update({
      where: { id: examResult.id },
      data: {
        summary: null,
        summaryStatus: RESULT_STATUS.GENERATING,
        summaryAiModel: null,
        summaryAiProvider: null,
        summaryServiceTier: null,
        summaryThinkingLevel: null,
        summaryTtftMs: null,
        summaryGenerationMs: null,
        summaryTotalMs: null,
        summaryTokens: null,
        summaryTokensEstimated: null,
      },
    });
    try {
      const { summary, metrics, providerType, serviceTier, thinkingLevel } =
        await generateSummary(examResult);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: {
          summary,
          summaryStatus: RESULT_STATUS.READY,
          aiModel: metrics.model,
          summaryAiModel: metrics.model,
          summaryAiProvider: providerType,
          summaryServiceTier: serviceTier,
          summaryThinkingLevel: thinkingLevel,
          summaryTtftMs: metrics.ttftMs,
          summaryGenerationMs: metrics.generationMs,
          summaryTotalMs: metrics.totalMs,
          summaryTokens: metrics.completionTokens,
          summaryTokensEstimated: metrics.tokensEstimated,
        },
      });
    } catch (err) {
      console.error(`[ExamResults] Summary generation failed for ${examResult.id}:`, err);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: { summaryStatus: RESULT_STATUS.FAILED },
      });
    }
  };

  const generateRecommendationsSection = async () => {
    if (examResult.recommendationsStatus === RESULT_STATUS.READY) return;
    await prisma.examResult.update({
      where: { id: examResult.id },
      data: {
        recommendationsStatus: RESULT_STATUS.GENERATING,
        recsAiModel: null,
        recsAiProvider: null,
        recsServiceTier: null,
        recsThinkingLevel: null,
        recsTtftMs: null,
        recsGenerationMs: null,
        recsTotalMs: null,
        recsTokens: null,
        recsTokensEstimated: null,
      },
    });
    try {
      const {
        stored,
        metrics,
        providerType,
        serviceTier,
        thinkingLevel,
        generationMs: recsGenerationMs,
      } = await generateRecommendations(examResult);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: {
          recommendations: JSON.stringify(stored),
          recommendationsStatus: RESULT_STATUS.READY,
          // Leave aiModel untouched (undefined) if this run made no LLM calls,
          // so a model recorded by the summary section survives.
          aiModel: metrics?.model ?? undefined,
          recsAiModel: metrics?.model ?? null,
          recsAiProvider: providerType,
          recsServiceTier: serviceTier,
          recsThinkingLevel: thinkingLevel,
          recsTtftMs: metrics?.ttftMs ?? null,
          recsGenerationMs,
          recsTotalMs: metrics?.totalMs ?? null,
          recsTokens: metrics?.completionTokens ?? null,
          recsTokensEstimated: metrics?.tokensEstimated ?? null,
        },
      });
    } catch (err) {
      console.error(`[ExamResults] Recommendation generation failed for ${examResult.id}:`, err);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: { recommendationsStatus: RESULT_STATUS.FAILED },
      });
    }
  };

  // The sections use independent provider assignments and persist independent
  // status/content, so run them together. A slow recommendation workflow no
  // longer delays the first summary token (and vice versa).
  await Promise.all([generateSummarySection(), generateRecommendationsSection()]);
}

/**
 * Resolve stored simulation refs against their live rows. Result snapshots keep
 * only the stable simulation id, so a teacher revision is immediately reflected
 * by the current version returned here while deleted/artifact-less rows become
 * unavailable instead of mounting an iframe that would 404.
 */
async function annotateSimulationAvailability(
  simulations: StoredSimulationRecommendation[]
): Promise<SimulationRecommendationView[]> {
  const rows = await prisma.questionSimulation.findMany({
    where: { id: { in: simulations.map((s) => s.simulationId) } },
    select: { id: true, storageKey: true, version: true },
  });
  const liveVersions = new Map(
    rows.filter((row) => row.storageKey !== null).map((row) => [row.id, row.version])
  );
  return simulations.map((simulation) => {
    const version = liveVersions.get(simulation.simulationId);
    return version === undefined
      ? { ...simulation, unavailable: true }
      : { ...simulation, version };
  });
}

/**
 * Parse stored recommendations and re-presign each page's image URL for display.
 * Returns empty when there is nothing stored or S3 is not configured.
 */
export async function presignStoredRecommendations(
  raw: string | null
): Promise<PresignedRecommendations> {
  const stored = parseStoredRecommendations(raw);
  // Misconception labels carry no images to presign, so pass them through
  // unchanged even when there are no material recommendations to presign
  // (e.g. a catalog match with zero available class materials, or S3 missing).
  // Simulations stream via their own route, but the snapshot outlives the
  // simulation rows themselves, so flag refs whose row is gone as unavailable.
  const errorMisconceptions = stored.errorMisconceptions;
  const simulations = stored.simulations
    ? await annotateSimulationAvailability(stored.simulations)
    : undefined;
  const passthrough = {
    ...(simulations ? { simulations } : {}),
    ...(errorMisconceptions ? { errorMisconceptions } : {}),
  };
  if (stored.items.length === 0) {
    return { items: [], truncated: stored.truncated, ...passthrough };
  }

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch {
    return { items: [], truncated: stored.truncated, ...passthrough };
  }

  const mapped = await mapPresignedRecommendations(stored, (key) =>
    signObjectReadUrl(bucket, key)
  );
  // mapPresignedRecommendations operates on the durable snapshot. Override its
  // raw simulation refs with the live availability/version data resolved above.
  return { ...mapped, ...passthrough };
}

/**
 * Convert server-only missed-question image keys into short-lived URLs. The
 * returned shape is safe to serialize to a student client: neither question
 * figures nor selected image responses retain their raw storage keys.
 */
export async function presignStudentMistakes(
  mistakes: StudentMistakeSource[]
): Promise<StudentMistakeView[]> {
  return Promise.all(
    mistakes.map(async (mistake) => {
      const figureUrl = await presignQuestionFigure({
        figureStorageKey: mistake.figureStorageKey,
        figureBucket: null,
      });

      if (mistake.response.kind === "numeric") {
        return {
          questionNumber: mistake.questionNumber,
          text: mistake.text,
          figureUrl,
          figureAlt: mistake.figureAlt,
          response: mistake.response,
        };
      }

      const choices = await Promise.all(
        mistake.response.choices.map(async (choice) => ({
          text: choice.text,
          imageUrl: await presignOptionImage({
            imageStorageKey: choice.imageStorageKey,
            imageBucket: null,
          }),
          imageAlt: choice.imageAlt,
        }))
      );

      return {
        questionNumber: mistake.questionNumber,
        text: mistake.text,
        figureUrl,
        figureAlt: mistake.figureAlt,
        response: { kind: "choices", choices },
      };
    })
  );
}
