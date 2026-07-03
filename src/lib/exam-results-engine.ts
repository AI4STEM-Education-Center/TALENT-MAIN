// Impure orchestration for generating + persisting an ExamResult's AI content.
// Runs in the background worker (decoupled from the HTTP request, so generation
// completes even if the student navigates away) and is also used by the results
// API/page to re-presign stored recommendation images on read. All DB / LLM /
// S3 access is concentrated here; the pure transforms live in `exam-results.ts`.

import type OpenAI from "openai";
import { prisma } from "./prisma";
import { resolveProvider, createOpenAIClient, type ResolvedProvider } from "./ai-provider";
import { streamChatCompletion, streamJsonCompletion, aggregateMetrics, type AiCallMetrics } from "./ai-streaming";
import { retryWithExponentialBackoff } from "./retry";
import { presignGetUrl, getS3Config } from "./storage";
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
  type ReviewSnapshot,
  type StoredRecommendation,
  type StoredRecommendations,
  type StoredMisconception,
  type StoredQuestionMisconceptions,
  type PresignedRecommendations,
} from "./exam-results";

const SUMMARY_MAX_TOKENS = 500;
const MAX_PAGES_PER_REC = 5;
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
 * (`max_completion_tokens` for cloud vs `max_tokens` for local) and service_tier
 * gating so stored summaries match the chatbot's output characteristics. Returns
 * the text plus its TTFT/token metrics.
 */
async function runChatCompletionText(
  provider: ResolvedProvider,
  messages: ChatMessage[],
  maxTokens: number
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
    },
    { includeUsage: !isLocal, requestOptions: { maxRetries: isLocal ? 0 : 3 } }
  );
}

/** Run one streamed structured (strict JSON schema) step, returning value + metrics. */
async function runStructuredStep<T>(
  client: OpenAI,
  model: string,
  prompt: string,
  schemaName: string,
  schema: object,
  isLocal: boolean
): Promise<{ value: T; metrics: AiCallMetrics }> {
  return streamJsonCompletion<T>(
    client,
    { model, messages: [{ role: "user", content: prompt }] },
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

/** Generate the markdown summary from the durable review snapshot. */
async function generateSummary(
  examResult: ExamResultRow
): Promise<{ summary: string; metrics: AiCallMetrics }> {
  const provider = await resolveProvider("student_chat");
  if (!providerUsable(provider)) {
    throw new Error("No usable AI provider configured for student_chat");
  }

  const snapshot = parseReviewSnapshot(examResult.reviewSnapshot);
  const attempt = snapshotToSummaryAttempt(snapshot, {
    score: examResult.score,
    completedAt: examResult.completedAt,
    className: examResult.className,
    topicName: examResult.topicName,
    quizName: examResult.quizName,
  });

  const { text, metrics } = await runChatCompletionText(
    provider,
    [{ role: "user", content: buildQuizReviewPrompt(attempt) }],
    SUMMARY_MAX_TOKENS
  );
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Model returned an empty summary");
  return { summary: trimmed, metrics };
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
): Promise<{ stored: StoredRecommendations; metrics: AiCallMetrics | null }> {
  const snapshot = parseReviewSnapshot(examResult.reviewSnapshot);
  const holistic = snapshotToHolisticInput(snapshot);
  // Nothing wrong (or an empty attempt) → no study recommendations needed.
  if (holistic.incorrectCount === 0) {
    return { stored: { items: [], truncated: false }, metrics: null };
  }

  const provider = await resolveProvider("student_chat");
  if (!providerUsable(provider)) return { stored: { items: [], truncated: false }, metrics: null };

  const isLocal = provider.providerType === "local";
  const client = await createOpenAIClient(provider);
  const allMetrics: AiCallMetrics[] = [];

  // Misconception labels are independent of study-material availability: run
  // them whenever there's a usable provider and incorrect answers, even when
  // no materials end up being recommended below (or S3 isn't configured at
  // all). A labeling failure never blocks the material recommendations.
  const { errorMisconceptions, metrics: labelMetrics } = await labelMisconceptions(
    client,
    provider.model,
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
    stored: { items, truncated, ...(errorMisconceptions.length > 0 ? { errorMisconceptions } : {}) },
    metrics,
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

  if (examResult.summaryStatus !== RESULT_STATUS.READY) {
    await prisma.examResult.update({
      where: { id: examResult.id },
      data: { summaryStatus: RESULT_STATUS.GENERATING },
    });
    try {
      const { summary, metrics } = await generateSummary(examResult);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: {
          summary,
          summaryStatus: RESULT_STATUS.READY,
          aiModel: metrics.model,
          summaryTtftMs: metrics.ttftMs,
          summaryTokens: metrics.completionTokens,
        },
      });
    } catch (err) {
      console.error(`[ExamResults] Summary generation failed for ${examResult.id}:`, err);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: { summaryStatus: RESULT_STATUS.FAILED },
      });
    }
  }

  if (examResult.recommendationsStatus !== RESULT_STATUS.READY) {
    await prisma.examResult.update({
      where: { id: examResult.id },
      data: { recommendationsStatus: RESULT_STATUS.GENERATING },
    });
    try {
      const { stored, metrics } = await generateRecommendations(examResult);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: {
          recommendations: JSON.stringify(stored),
          recommendationsStatus: RESULT_STATUS.READY,
          // Leave aiModel untouched (undefined) if this run made no LLM calls,
          // so a model recorded by the summary section survives.
          aiModel: metrics?.model ?? undefined,
          recsTtftMs: metrics?.ttftMs ?? null,
          recsTokens: metrics?.completionTokens ?? null,
        },
      });
    } catch (err) {
      console.error(`[ExamResults] Recommendation generation failed for ${examResult.id}:`, err);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: { recommendationsStatus: RESULT_STATUS.FAILED },
      });
    }
  }
}

/**
 * Parse stored recommendations and re-presign each page's image URL for display.
 * Returns empty when there is nothing stored or S3 is not configured.
 */
export async function presignStoredRecommendations(
  raw: string | null
): Promise<PresignedRecommendations> {
  const stored = parseStoredRecommendations(raw);
  // Teacher-only misconception labels carry no images to presign, so pass them through unchanged
  // even when there are no material recommendations to presign (e.g. a
  // catalog match with zero available class materials).
  const errorMisconceptions = stored.errorMisconceptions;
  if (stored.items.length === 0) {
    return { items: [], truncated: stored.truncated, ...(errorMisconceptions ? { errorMisconceptions } : {}) };
  }

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch {
    return { items: [], truncated: stored.truncated, ...(errorMisconceptions ? { errorMisconceptions } : {}) };
  }

  return mapPresignedRecommendations(stored, (key) => presignGetUrl(bucket, key));
}
