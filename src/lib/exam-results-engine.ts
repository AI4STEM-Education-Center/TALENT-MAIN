// Impure orchestration for generating + persisting an ExamResult's AI content.
// Runs in the background worker (decoupled from the HTTP request, so generation
// completes even if the student navigates away) and is also used by the results
// API/page to re-presign stored recommendation images on read. All DB / LLM /
// S3 access is concentrated here; the pure transforms live in `exam-results.ts`.

import type OpenAI from "openai";
import { prisma } from "./prisma";
import { resolveProvider, createOpenAIClient, type ResolvedProvider } from "./ai-provider";
import { presignGetUrl, getS3Config } from "./storage";
import { buildQuizReviewPrompt, type ChatMessage } from "./chat-prompt";
import {
  FILE_SELECTION_SCHEMA,
  PAGE_SELECTION_SCHEMA,
  buildFileSelectionPrompt,
  buildPageSelectionPrompt,
  resolveSelectedMaterial,
  clampPageRange,
  type MisconceptionInput,
  type CatalogMaterial,
  type CatalogPage,
  type FileSelection,
  type PageSelection,
} from "./recommendation";
import {
  RESULT_STATUS,
  parseReviewSnapshot,
  parseStoredRecommendations,
  snapshotToMisconceptions,
  snapshotToSummaryAttempt,
  mapPresignedRecommendations,
  type StoredRecommendation,
  type StoredRecommendations,
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
  subtopicName: string;
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

/** Extract the first balanced-looking JSON object from a free-text response. */
function parseFirstJsonObject<T>(content: string): T {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in model response");
  return JSON.parse(match[0]) as T;
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
 * Non-streaming chat completion. Mirrors the streaming chat route's token-cap
 * (`max_completion_tokens` for cloud vs `max_tokens` for local) and service_tier
 * gating so stored summaries match the chatbot's output characteristics.
 */
async function runChatCompletionText(
  provider: ResolvedProvider,
  messages: ChatMessage[],
  maxTokens: number
): Promise<string> {
  const client = await createOpenAIClient(provider);
  const isLocal = provider.providerType === "local";
  const serviceTier = provider.serviceTier;
  const tierActive =
    !isLocal && (serviceTier === "auto" || serviceTier === "default" || serviceTier === "flex");

  const res = await client.chat.completions.create(
    {
      model: provider.model,
      messages: messages as never,
      temperature: 0.7,
      stream: false,
      max_completion_tokens: !isLocal ? maxTokens : undefined,
      max_tokens: isLocal ? maxTokens : undefined,
      service_tier: tierActive ? (serviceTier as never) : undefined,
    },
    { maxRetries: isLocal ? 0 : 3 }
  );
  return res.choices?.[0]?.message?.content ?? "";
}

/** Run one structured (strict JSON schema) step, falling back to text parsing. */
async function runStructuredStep<T>(
  client: OpenAI,
  model: string,
  prompt: string,
  schemaName: string,
  schema: object
): Promise<T> {
  const messages = [{ role: "user" as const, content: prompt }];
  try {
    const res = await client.chat.completions.create({
      model,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, schema: schema as Record<string, unknown>, strict: true },
      },
    });
    return JSON.parse(res.choices?.[0]?.message?.content ?? "") as T;
  } catch {
    const res = await client.chat.completions.create({ model, messages });
    return parseFirstJsonObject<T>(res.choices?.[0]?.message?.content ?? "");
  }
}

/** Two-step recommendation for one misconception, returning storageKeys (not URLs). */
async function recommendForMisconception(
  client: OpenAI,
  model: string,
  input: MisconceptionInput,
  catalog: CatalogMaterial[],
  materials: MaterialRow[]
): Promise<StoredRecommendation | null> {
  const fileSelection = await runStructuredStep<FileSelection>(
    client,
    model,
    buildFileSelectionPrompt(input, catalog),
    "file_selection",
    FILE_SELECTION_SCHEMA
  );

  const chosen = resolveSelectedMaterial(fileSelection.material_index, catalog);
  if (!chosen) return null;
  const material = materials[chosen.index - 1];
  if (!material) return null;

  const teachingPages = material.pages.filter((p) => p.needed !== false);
  const usablePages = teachingPages.length > 0 ? teachingPages : material.pages;
  if (usablePages.length === 0) return null;

  const catalogPages: CatalogPage[] = usablePages.map((p) => ({
    pageNumber: p.pageNumber,
    keyConcept: p.keyConcept ?? "",
    description: p.description ?? "",
  }));

  const pageSelection = await runStructuredStep<PageSelection>(
    client,
    model,
    buildPageSelectionPrompt(input, chosen.title, catalogPages),
    "page_selection",
    PAGE_SELECTION_SCHEMA
  );

  const range = clampPageRange(
    pageSelection.start_page,
    pageSelection.end_page,
    usablePages.map((p) => p.pageNumber)
  );
  if (!range) return null;

  const selectedPages = usablePages
    .filter((p) => p.pageNumber >= range.start && p.pageNumber <= range.end)
    .slice(0, MAX_PAGES_PER_REC);
  if (selectedPages.length === 0) return null;

  return {
    questionText: input.questionText,
    materialTitle: chosen.title,
    pageRange: range,
    fileReason: fileSelection.reasoning,
    pageReason: pageSelection.reasoning,
    pages: selectedPages.map((p) => ({ pageNumber: p.pageNumber, storageKey: p.storageKey })),
  };
}

/** Generate the markdown summary from the durable review snapshot. */
async function generateSummary(examResult: ExamResultRow): Promise<string> {
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
    subtopicName: examResult.subtopicName,
  });

  const summary = await runChatCompletionText(
    provider,
    [{ role: "user", content: buildQuizReviewPrompt(attempt) }],
    SUMMARY_MAX_TOKENS
  );
  const trimmed = summary.trim();
  if (!trimmed) throw new Error("Model returned an empty summary");
  return trimmed;
}

/**
 * Generate recommendations from the snapshot's incorrect answers + the class's
 * processed materials. Environment gaps (no provider / no materials / no S3) and
 * a perfect score yield an empty-but-terminal result rather than an error.
 */
async function generateRecommendations(examResult: ExamResultRow): Promise<StoredRecommendations> {
  const snapshot = parseReviewSnapshot(examResult.reviewSnapshot);
  const { inputs, truncated } = snapshotToMisconceptions(snapshot);
  if (inputs.length === 0) return { items: [], truncated: false };

  const provider = await resolveProvider("student_chat");
  if (!providerUsable(provider)) return { items: [], truncated };

  try {
    getS3Config();
  } catch {
    return { items: [], truncated };
  }

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
  if (materials.length === 0) return { items: [], truncated };

  const client = await createOpenAIClient(provider);
  const catalog: CatalogMaterial[] = materials.map((m, i) => ({
    index: i + 1,
    title: m.title?.trim() || m.originalName,
    description: m.batchDescription ?? "",
    keyConcepts: parseKeyConcepts(m.batchKeyConcepts),
  }));

  const results = await Promise.all(
    inputs.map(async (input) => {
      try {
        return await recommendForMisconception(client, provider.model, input, catalog, materials);
      } catch (err) {
        console.error("[ExamResults] Failed to build a recommendation:", err);
        return null;
      }
    })
  );

  return { items: results.filter((r): r is StoredRecommendation => r !== null), truncated };
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
      const summary = await generateSummary(examResult);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: { summary, summaryStatus: RESULT_STATUS.READY },
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
      const stored = await generateRecommendations(examResult);
      await prisma.examResult.update({
        where: { id: examResult.id },
        data: { recommendations: JSON.stringify(stored), recommendationsStatus: RESULT_STATUS.READY },
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
  if (stored.items.length === 0) return { items: [], truncated: stored.truncated };

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch {
    return { items: [], truncated: stored.truncated };
  }

  return mapPresignedRecommendations(stored, (key) => presignGetUrl(bucket, key));
}
