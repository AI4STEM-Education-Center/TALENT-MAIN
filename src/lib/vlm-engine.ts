import { OpenAI } from "openai";
import { prisma } from "@/lib/prisma";
import { getS3Config, resolveModelImageUrl } from "@/lib/storage";
import { resolveProvider, createOpenAIClient } from "@/lib/ai-provider";
import { retryWithExponentialBackoff } from "./retry";
import { streamJsonCompletion, aggregateMetrics, type AiCallMetrics } from "./ai-streaming";
import { getActiveConceptLabels } from "./concept-catalog";

// In-memory set of material IDs whose processing should be aborted.
const cancelledMaterials = new Set<string>();

export function cancelMaterial(materialId: string) {
  cancelledMaterials.add(materialId);
}

function isCancelled(materialId: string): boolean {
  return cancelledMaterials.has(materialId);
}

const TIER1_SCHEMA = {
  name: "page_assessment",
  strict: true,
  schema: {
    type: "object",
    properties: {
      needed: { type: "boolean" },
      key_concept: { type: "string" },
      description: { type: "string" },
    },
    required: ["needed", "key_concept", "description"],
    additionalProperties: false,
  },
};

const TIER2_SCHEMA = {
  name: "batch_summary",
  strict: true,
  schema: {
    type: "object",
    properties: {
      key_concept: { type: "array", items: { type: "string" } },
      description: { type: "string" },
    },
    required: ["key_concept", "description"],
    additionalProperties: false,
  },
};

/**
 * "None" is the escape hatch offered to tier-1 (per-page) key-concept
 * selection when a curated concept catalog is active — a single page may
 * genuinely not match any listed concept, whereas the tier-2 batch summary
 * can just omit concepts it doesn't find (empty array), so it gets no such
 * sentinel.
 */
const NONE_CONCEPT = "None";

/**
 * Build the tier-1 (per-page) response schema. With an empty allow-list this
 * returns the exact TIER1_SCHEMA object used today (free-form key_concept
 * string) — callers must pass [] when no concept catalog is configured.
 */
export function buildTier1Schema(allowedConcepts: string[]) {
  if (allowedConcepts.length === 0) return TIER1_SCHEMA;
  return {
    ...TIER1_SCHEMA,
    schema: {
      ...TIER1_SCHEMA.schema,
      properties: {
        ...TIER1_SCHEMA.schema.properties,
        key_concept: { type: "string", enum: [...allowedConcepts, NONE_CONCEPT] },
      },
    },
  };
}

/**
 * Build the tier-2 (batch summary) response schema. With an empty allow-list
 * this returns the exact TIER2_SCHEMA object used today (free-form
 * key_concept string array).
 */
export function buildTier2Schema(allowedConcepts: string[]) {
  if (allowedConcepts.length === 0) return TIER2_SCHEMA;
  return {
    ...TIER2_SCHEMA,
    schema: {
      ...TIER2_SCHEMA.schema,
      properties: {
        ...TIER2_SCHEMA.schema.properties,
        key_concept: { type: "array", items: { type: "string", enum: allowedConcepts } },
      },
    },
  };
}

/** Render the allowed-concept list as a Markdown bullet list, one per line. */
export function formatConceptBulletList(allowedConcepts: string[]): string {
  return allowedConcepts.map((label) => `- ${label}`).join("\n");
}

const TIER1_BASE_PROMPT =
  "You are analyzing a single page from an educational document. Extract the key concept and a brief description. Determine if this page is needed for understanding the core material (e.g., skip table of contents or blank pages).";

const TIER2_BASE_PROMPT =
  "Based on these pages from a learning material, provide a cohesive batch summary and a list of overarching key concepts across the document.";

/**
 * Build the tier-1 (per-page) prompt. With an empty allow-list this returns
 * exactly TIER1_BASE_PROMPT unchanged.
 */
export function buildTier1Prompt(allowedConcepts: string[]): string {
  if (allowedConcepts.length === 0) return TIER1_BASE_PROMPT;
  return `${TIER1_BASE_PROMPT} Choose key_concept ONLY from this list (use the exact label). If no listed concept fits, use "None".\n${formatConceptBulletList(allowedConcepts)}`;
}

/**
 * Build the tier-2 (batch summary) prompt. With an empty allow-list this
 * returns exactly TIER2_BASE_PROMPT unchanged.
 */
export function buildTier2Prompt(allowedConcepts: string[]): string {
  if (allowedConcepts.length === 0) return TIER2_BASE_PROMPT;
  return `${TIER2_BASE_PROMPT} Choose key concepts ONLY from this list (use the exact labels). Return an empty list if none apply.\n${formatConceptBulletList(allowedConcepts)}`;
}

/**
 * Post-validation for tier-1 key_concept (defense in depth: ai-streaming falls
 * back to plain, unconstrained streaming when a provider rejects
 * response_format, so the schema enum alone isn't a guarantee). With an empty
 * allow-list, the raw value passes through untouched (today's free-form
 * behavior). Otherwise "None" or any value outside the catalog is nulled out.
 */
export function resolveTier1KeyConcept(value: string, allowedConcepts: string[]): string | null {
  if (allowedConcepts.length === 0) return value;
  if (value === NONE_CONCEPT) return null;
  return allowedConcepts.includes(value) ? value : null;
}

/**
 * Post-validation for tier-2 key_concept array (same defense-in-depth
 * rationale as resolveTier1KeyConcept). With an empty allow-list, the raw
 * array passes through untouched.
 */
export function filterTier2KeyConcepts(values: string[], allowedConcepts: string[]): string[] {
  if (allowedConcepts.length === 0) return values;
  return values.filter((v) => allowedConcepts.includes(v));
}

/**
 * Build an OpenAI client from the resolved PDF description provider config.
 * Throws if no provider is configured. Local providers need no API key (they
 * authenticate via base URL); hosted providers (OpenAI/Cloudflare) still do.
 * `isLocal` is surfaced so the page-image transport can switch to inline base64
 * for local models — see `resolveModelImageUrl`.
 */
async function getConfiguredOpenAI(): Promise<{
  client: OpenAI;
  model: string;
  serviceTier: string | null;
  isLocal: boolean;
}> {
  const provider = await resolveProvider("pdf_description");

  if (!provider) {
    throw new Error(
      "No AI provider configured for PDF description generation. " +
        "An admin must configure the 'pdf_description' use case in the AI Config dashboard."
    );
  }

  const isLocal = provider.providerType === "local";
  if (!isLocal && !provider.apiKey) {
    throw new Error("PDF description provider has no API key configured.");
  }

  const client = await createOpenAIClient(provider);

  return {
    client,
    model: provider.model,
    serviceTier: provider.serviceTier,
    isLocal,
  };
}

async function processPage(
  materialId: string,
  pageNumber: number,
  storageKey: string,
  bucket: string,
  openai: OpenAI,
  model: string,
  serviceTier: string | null,
  isLocal: boolean,
  allowedConcepts: string[]
): Promise<AiCallMetrics> {
  // Resolve a model-ready URL for this page: a JIT presigned link for hosted
  // providers, or an inline base64 data URL for local ones that can't reach S3.
  const imageUrl = await resolveModelImageUrl(bucket, storageKey, { inlineBase64: isLocal, expiresIn: 3600 });

  const prompt = buildTier1Prompt(allowedConcepts);

  const { value, metrics } = await retryWithExponentialBackoff(() =>
    streamJsonCompletion<{ needed: boolean; key_concept: string; description: string }>(
      openai,
      {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        service_tier: serviceTier === "flex" ? "flex" : undefined,
      },
      buildTier1Schema(allowedConcepts),
      { includeUsage: !isLocal, requestOptions: { maxRetries: isLocal ? 0 : 3 } }
    )
  );

  await prisma.materialPage.update({
    where: { materialId_pageNumber: { materialId, pageNumber } },
    data: {
      needed: value.needed,
      keyConcept: resolveTier1KeyConcept(value.key_concept, allowedConcepts),
      description: value.description,
    },
  });

  await prisma.learningMaterial.update({
    where: { id: materialId },
    data: { processedPages: { increment: 1 } },
  });

  return metrics;
}

export async function processMaterial(materialId: string) {
  // Clear any stale cancellation from a previous run of the same ID
  cancelledMaterials.delete(materialId);

  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    include: { pages: { orderBy: { pageNumber: "asc" } } },
  });

  if (!material) throw new Error("Material not found");
  if (material.pages.length === 0) throw new Error("No pages found for material");

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch (e) {
    throw new Error("S3 not configured");
  }

  // Resolve provider from DB config
  const { client: openai, model, serviceTier, isLocal } = await getConfiguredOpenAI();

  // Active concept catalog, loaded once for the whole run. Empty means no
  // curated catalog is configured — every prompt/schema/post-validation
  // helper below treats [] as "free-form, exactly like today".
  const allowedConcepts = await getActiveConceptLabels();

  // Per-call AI metrics (TTFT + generated tokens) collected across every page
  // and the batch-summary call, aggregated onto the material when it succeeds.
  const callMetrics: AiCallMetrics[] = [];

  // Tier 1: Process pages in batches of 5
  const CONCURRENCY = 5;
  const pagesToProcess = material.pages.filter(p => p.description === null); // Support retry
  
  for (let i = 0; i < pagesToProcess.length; i += CONCURRENCY) {
    if (isCancelled(materialId)) {
      console.log(`[VLM Engine] Processing cancelled for material ${materialId}`);
      cancelledMaterials.delete(materialId);
      return;
    }
    const batch = pagesToProcess.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((page) =>
        processPage(materialId, page.pageNumber, page.storageKey, bucket, openai, model, serviceTier, isLocal, allowedConcepts)
          .then((m) => { callMetrics.push(m); })
          .catch((err) => {
            console.error(`[VLM Engine] Failed to process page ${page.pageNumber}:`, err);
            // Don't fail the whole batch, allow retry mechanism later
          })
      )
    );
  }

  // Retry failed pages up to 3 times
  const MAX_PAGE_RETRIES = 3;
  for (let retryAttempt = 1; retryAttempt <= MAX_PAGE_RETRIES; retryAttempt++) {
    if (isCancelled(materialId)) {
      console.log(`[VLM Engine] Processing cancelled for material ${materialId} during retry`);
      cancelledMaterials.delete(materialId);
      return;
    }

    const materialCheck = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
    });
    if (!materialCheck || materialCheck.processedPages >= materialCheck.totalPages) {
      break; // All pages processed successfully
    }

    const failedPages = await prisma.materialPage.findMany({
      where: { materialId, description: null },
      orderBy: { pageNumber: "asc" },
    });

    if (failedPages.length === 0) break;

    console.log(`[VLM Engine] Retry attempt ${retryAttempt}/${MAX_PAGE_RETRIES}: ${failedPages.length} failed pages for material ${materialId}`);

    for (let i = 0; i < failedPages.length; i += CONCURRENCY) {
      if (isCancelled(materialId)) {
        cancelledMaterials.delete(materialId);
        return;
      }
      const batch = failedPages.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((page) =>
          processPage(materialId, page.pageNumber, page.storageKey, bucket, openai, model, serviceTier, isLocal, allowedConcepts)
            .then((m) => { callMetrics.push(m); })
            .catch((err) => {
              console.error(`[VLM Engine] Retry ${retryAttempt} failed for page ${page.pageNumber}:`, err);
            })
        )
      );
    }
  }

  // Final check: if still incomplete after all retries, mark FAILED
  const materialAfterRetries = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
  });
  if (materialAfterRetries && materialAfterRetries.processedPages < materialAfterRetries.totalPages) {
    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: {
        processingStatus: "FAILED",
        errorMessage: `Only ${materialAfterRetries.processedPages}/${materialAfterRetries.totalPages} pages processed successfully after ${MAX_PAGE_RETRIES} retry attempts.`,
      },
    });
    return;
  }

  // Check cancellation before Tier 2
  if (isCancelled(materialId)) {
    console.log(`[VLM Engine] Processing cancelled for material ${materialId} before Tier 2`);
    cancelledMaterials.delete(materialId);
    return;
  }

  // Tier 2: Batch summary
  // Refresh pages after Tier 1 to get latest state
  const updatedMaterial = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    include: { pages: { orderBy: { pageNumber: "asc" } } },
  });

  if (!updatedMaterial) return;

  const neededPages = updatedMaterial.pages.filter((p) => p.needed === true && p.description !== null);
  
  if (neededPages.length === 0) {
    // Edge case: no pages needed or all failed. Persist whatever Tier 1 metrics
    // we collected so the teacher still sees the model + token usage.
    const agg = aggregateMetrics(callMetrics);
    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: {
        processingStatus: "SUCCESS",
        batchDescription: "No pages were identified as core learning material.",
        batchKeyConcepts: "[]",
        aiModel: agg?.model ?? null,
        aiTtftMs: agg?.ttftMs ?? null,
        aiTokens: agg?.completionTokens ?? null,
      },
    });
    return;
  }

  // Resolve model-ready URLs for Tier 2: presigned links for hosted providers,
  // inline base64 data URLs for local ones that can't reach S3.
  const imageUrls = await Promise.all(
    neededPages.map((p) => resolveModelImageUrl(bucket, p.storageKey, { inlineBase64: isLocal, expiresIn: 3600 }))
  );

  const contentArray: any[] = [
    {
      type: "text",
      text: buildTier2Prompt(allowedConcepts),
    },
  ];

  for (const url of imageUrls) {
    contentArray.push({ type: "image_url", image_url: { url } });
  }

  try {
    const { value, metrics } = await retryWithExponentialBackoff(() =>
      streamJsonCompletion<{ description: string; key_concept: string[] }>(
        openai,
        {
          model,
          messages: [{ role: "user", content: contentArray }],
          service_tier: serviceTier === "flex" ? "flex" : undefined,
        },
        buildTier2Schema(allowedConcepts),
        { includeUsage: !isLocal, requestOptions: { maxRetries: isLocal ? 0 : 3 } }
      )
    );
    callMetrics.push(metrics);

    const agg = aggregateMetrics(callMetrics);
    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: {
        processingStatus: "SUCCESS",
        batchDescription: value.description,
        batchKeyConcepts: JSON.stringify(filterTier2KeyConcepts(value.key_concept, allowedConcepts)),
        aiModel: agg?.model ?? null,
        aiTtftMs: agg?.ttftMs ?? null,
        aiTokens: agg?.completionTokens ?? null,
      },
    });
  } catch (err: any) {
    console.error(`[VLM Engine] Tier 2 processing failed:`, err);
    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: {
        processingStatus: "FAILED",
        errorMessage: err.message || "Failed to generate batch summary",
      },
    });
  }
}
