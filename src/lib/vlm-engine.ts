import { OpenAI } from "openai";
import { prisma } from "@/lib/prisma";
import { getS3Config, resolveModelImageUrl } from "@/lib/storage";
import {
  resolveProvider,
  createOpenAIClient,
  thinkingParams,
  type ResolvedProvider,
  type ThinkingLevel,
  type ThinkingParams,
} from "@/lib/ai-provider";
import { retryWithExponentialBackoff } from "./retry";
import {
  streamJsonCompletion,
  aggregateMetrics,
  streamOptionsFor,
  transportFor,
  type AiCallMetrics,
  type AiTransport,
} from "./ai-streaming";
import { getActiveConceptLabels } from "./concept-catalog";
import { fenceUntrusted, UNTRUSTED_CONTENT_RULE } from "./guardrail-fence";
import { moderateImages } from "./guardrails";
import { auditText } from "./guardrail-runner";
import {
  getGuardrailSettings,
  moderationEnabledFor,
} from "./guardrail-settings";

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
 * Build the tier-1 (per-page) response schema. Empty catalogs fail closed.
 */
export function buildTier1Schema(allowedConcepts: string[]) {
  requireActiveConcepts(allowedConcepts);
  return {
    ...TIER1_SCHEMA,
    schema: {
      ...TIER1_SCHEMA.schema,
      properties: {
        ...TIER1_SCHEMA.schema.properties,
        key_concept: {
          type: "string",
          enum: [...allowedConcepts, NONE_CONCEPT],
        },
      },
    },
  };
}

/**
 * Build the tier-2 (batch summary) response schema. Empty catalogs fail closed.
 */
export function buildTier2Schema(allowedConcepts: string[]) {
  requireActiveConcepts(allowedConcepts);
  return {
    ...TIER2_SCHEMA,
    schema: {
      ...TIER2_SCHEMA.schema,
      properties: {
        ...TIER2_SCHEMA.schema.properties,
        key_concept: {
          type: "array",
          items: { type: "string", enum: allowedConcepts },
        },
      },
    },
  };
}

/** Render the allowed-concept list as a Markdown bullet list, one per line. */
export function formatConceptBulletList(allowedConcepts: string[]): string {
  return allowedConcepts.map((label) => `- ${label}`).join("\n");
}

function requireActiveConcepts(allowedConcepts: string[]): void {
  if (allowedConcepts.length === 0) {
    throw new Error(
      "The active concept catalog is empty. Upload concepts in the admin dashboard before generating material descriptions.",
    );
  }
}

const TIER1_BASE_PROMPT =
  "You are analyzing a single page from an educational document. Extract the key concept and a brief description. Determine if this page is needed for understanding the core material (e.g., skip table of contents or blank pages). Pages consisting mainly of example or practice problems do not convey core content on their own—especially problem statements presented without worked solutions or explanations—so mark such pages as not needed unless they include the explanatory solution or derivation that actually teaches the concept.";

const TIER2_BASE_PROMPT =
  "Based on these pages from a learning material, provide a cohesive batch summary and a list of overarching key concepts across the document.";

/**
 * Build the tier-1 (per-page) prompt. Empty catalogs fail closed.
 */
export function buildTier1Prompt(allowedConcepts: string[]): string {
  requireActiveConcepts(allowedConcepts);
  // Concept labels arrive by admin CSV import, so they are fenced like any
  // other stored text. The response schema already pins key_concept to this
  // enum; the fence protects the surrounding instructions instead.
  return `${TIER1_BASE_PROMPT} Choose key_concept ONLY from this list (use the exact label). If no listed concept fits, use "None". The description must discuss only the selected listed concept and must not introduce unlisted concepts.

${UNTRUSTED_CONTENT_RULE}

${fenceUntrusted("concept catalog", formatConceptBulletList(allowedConcepts))}`;
}

/**
 * Build the tier-2 (batch summary) prompt. Empty catalogs fail closed.
 */
export function buildTier2Prompt(allowedConcepts: string[]): string {
  requireActiveConcepts(allowedConcepts);
  return `${TIER2_BASE_PROMPT} Choose key concepts ONLY from this list (use the exact labels). Return an empty list if none apply. The description must discuss only concepts selected from this list and must not introduce unlisted concepts.

${UNTRUSTED_CONTENT_RULE}

${fenceUntrusted("concept catalog", formatConceptBulletList(allowedConcepts))}`;
}

/**
 * Post-validation for tier-1 key_concept (defense in depth: ai-streaming falls
 * back to plain, unconstrained streaming when a provider rejects
 * response_format, so the schema enum alone isn't a guarantee). "None" or any
 * value outside the catalog is nulled out; empty catalogs fail closed.
 */
export function resolveTier1KeyConcept(
  value: string,
  allowedConcepts: string[],
): string | null {
  requireActiveConcepts(allowedConcepts);
  if (value === NONE_CONCEPT) return null;
  return allowedConcepts.includes(value) ? value : null;
}

/**
 * Post-validation for tier-2 key_concept array (same defense-in-depth
 * rationale as resolveTier1KeyConcept). Empty catalogs fail closed.
 */
export function filterTier2KeyConcepts(
  values: string[],
  allowedConcepts: string[],
): string[] {
  requireActiveConcepts(allowedConcepts);
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
  providerType: ResolvedProvider["providerType"];
  serviceTier: string | null;
  /** Reasoning effort pinned on the model, or null. Sent on calls and persisted. */
  thinkingLevel: ThinkingLevel | null;
  isLocal: boolean;
  transport: AiTransport;
}> {
  const provider = await resolveProvider("pdf_description");

  if (!provider) {
    throw new Error(
      "No AI provider configured for PDF description generation. " +
        "An admin must configure the 'pdf_description' use case in the AI Config dashboard.",
    );
  }

  const isLocal = provider.providerType === "local";
  const transport = transportFor(provider);
  if (!isLocal && !provider.apiKey) {
    throw new Error("PDF description provider has no API key configured.");
  }

  const client = await createOpenAIClient(provider);

  return {
    client,
    model: provider.model,
    providerType: provider.providerType,
    serviceTier: provider.serviceTier,
    thinkingLevel: provider.thinkingLevel,
    isLocal,
    transport,
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
  thinking: ThinkingParams,
  transport: AiTransport,
  allowedConcepts: string[],
  /** Free page-image moderation, per the admin's guardrail settings. */
  moderatePages: boolean,
): Promise<AiCallMetrics> {
  // Resolve a model-ready URL for this page: a JIT presigned link for hosted
  // providers, or an inline base64 data URL for local ones that can't reach S3.
  const imageUrl = await resolveModelImageUrl(bucket, storageKey, {
    inlineBase64: transport.isLocal,
    expiresIn: 3600,
  });

  // Audit, not a gate: one flagged page must not abandon a teacher's whole
  // upload, and the description model sees the page either way. The log row is
  // what an admin acts on. Fire-and-forget so it never adds to page latency.
  if (moderatePages)
    void moderateImages([imageUrl], {
      surface: "material_page",
      id: materialId,
    });

  const prompt = buildTier1Prompt(allowedConcepts);

  const { value, metrics } = await retryWithExponentialBackoff(() =>
    streamJsonCompletion<{
      needed: boolean;
      key_concept: string;
      description: string;
    }>(
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
        // Empty unless an admin pinned a thinking level on this model.
        ...thinking,
      },
      buildTier1Schema(allowedConcepts),
      streamOptionsFor(transport),
    ),
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
  if (material.pages.length === 0)
    throw new Error("No pages found for material");

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch (e) {
    throw new Error("S3 not configured");
  }

  // Fail closed before making any AI call: material concept metadata and its
  // prose description must always be grounded in the admin-managed catalog.
  const allowedConcepts = await getActiveConceptLabels();
  // Read once for the whole job rather than per page: the settings are cached
  // for 60s anyway, and a mid-document toggle flip should not split a document
  // into moderated and unmoderated halves.
  const guardrailSettings = await getGuardrailSettings();
  const moderatePages = moderationEnabledFor(
    guardrailSettings,
    "material_page",
  );
  requireActiveConcepts(allowedConcepts);

  // Resolve provider from DB config
  const {
    client: openai,
    model,
    providerType,
    serviceTier,
    thinkingLevel,
    isLocal,
    transport,
  } = await getConfiguredOpenAI();
  // Derived once and passed to every call below; empty unless a level is pinned.
  const thinking = thinkingParams({ thinkingLevel });

  // Per-call AI metrics (TTFT + generated tokens) collected across every page
  // and the batch-summary call, aggregated onto the material when it succeeds.
  const callMetrics: AiCallMetrics[] = [];

  // Tier 1: Process pages in batches of 5
  const CONCURRENCY = 5;
  const pagesToProcess = material.pages.filter((p) => p.description === null); // Support retry

  for (let i = 0; i < pagesToProcess.length; i += CONCURRENCY) {
    if (isCancelled(materialId)) {
      console.log(
        `[VLM Engine] Processing cancelled for material ${materialId}`,
      );
      cancelledMaterials.delete(materialId);
      return;
    }
    const batch = pagesToProcess.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((page) =>
        processPage(
          materialId,
          page.pageNumber,
          page.storageKey,
          bucket,
          openai,
          model,
          serviceTier,
          thinking,
          transport,
          allowedConcepts,
          moderatePages,
        )
          .then((m) => {
            callMetrics.push(m);
          })
          .catch((err) => {
            console.error(
              `[VLM Engine] Failed to process page ${page.pageNumber}:`,
              err,
            );
            // Don't fail the whole batch, allow retry mechanism later
          }),
      ),
    );
  }

  // Retry failed pages up to 3 times
  const MAX_PAGE_RETRIES = 3;
  for (let retryAttempt = 1; retryAttempt <= MAX_PAGE_RETRIES; retryAttempt++) {
    if (isCancelled(materialId)) {
      console.log(
        `[VLM Engine] Processing cancelled for material ${materialId} during retry`,
      );
      cancelledMaterials.delete(materialId);
      return;
    }

    const materialCheck = await prisma.learningMaterial.findUnique({
      where: { id: materialId },
    });
    if (
      !materialCheck ||
      materialCheck.processedPages >= materialCheck.totalPages
    ) {
      break; // All pages processed successfully
    }

    const failedPages = await prisma.materialPage.findMany({
      where: { materialId, description: null },
      orderBy: { pageNumber: "asc" },
    });

    if (failedPages.length === 0) break;

    console.log(
      `[VLM Engine] Retry attempt ${retryAttempt}/${MAX_PAGE_RETRIES}: ${failedPages.length} failed pages for material ${materialId}`,
    );

    for (let i = 0; i < failedPages.length; i += CONCURRENCY) {
      if (isCancelled(materialId)) {
        cancelledMaterials.delete(materialId);
        return;
      }
      const batch = failedPages.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((page) =>
          processPage(
            materialId,
            page.pageNumber,
            page.storageKey,
            bucket,
            openai,
            model,
            serviceTier,
            thinking,
            transport,
            allowedConcepts,
            moderatePages,
          )
            .then((m) => {
              callMetrics.push(m);
            })
            .catch((err) => {
              console.error(
                `[VLM Engine] Retry ${retryAttempt} failed for page ${page.pageNumber}:`,
                err,
              );
            }),
        ),
      );
    }
  }

  // Final check: if still incomplete after all retries, mark FAILED
  const materialAfterRetries = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
  });
  if (
    materialAfterRetries &&
    materialAfterRetries.processedPages < materialAfterRetries.totalPages
  ) {
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
    console.log(
      `[VLM Engine] Processing cancelled for material ${materialId} before Tier 2`,
    );
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

  const neededPages = updatedMaterial.pages.filter(
    (p) => p.needed === true && p.description !== null,
  );

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
        aiProvider: agg ? providerType : null,
        aiServiceTier: agg ? serviceTier : null,
        aiThinkingLevel: agg ? thinkingLevel : null,
        aiTtftMs: agg?.ttftMs ?? null,
        aiTokens: agg?.completionTokens ?? null,
        aiTotalMs: agg?.totalMs ?? null,
      },
    });
    return;
  }

  // ── Guardrail: one check over what the model actually READ off the PDF. ──
  // The page images went through free moderation as they were processed; this
  // asks the classifier whether the extracted prose is trying to steer an
  // assistant. One call for the whole document, and audit-only — the
  // descriptions feed recommendations, so a finding is something an admin
  // should see rather than a reason to discard a processed upload.
  void auditText(neededPages.map((p) => p.description ?? "").join("\n\n"), {
    surface: "material_description",
    id: materialId,
  });

  // Resolve model-ready URLs for Tier 2: presigned links for hosted providers,
  // inline base64 data URLs for local ones that can't reach S3.
  const imageUrls = await Promise.all(
    neededPages.map((p) =>
      resolveModelImageUrl(bucket, p.storageKey, {
        inlineBase64: isLocal,
        expiresIn: 3600,
      }),
    ),
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
          ...thinking,
        },
        buildTier2Schema(allowedConcepts),
        streamOptionsFor(transport),
      ),
    );
    callMetrics.push(metrics);

    const agg = aggregateMetrics(callMetrics);
    await prisma.learningMaterial.update({
      where: { id: materialId },
      data: {
        processingStatus: "SUCCESS",
        batchDescription: value.description,
        batchKeyConcepts: JSON.stringify(
          filterTier2KeyConcepts(value.key_concept, allowedConcepts),
        ),
        aiModel: agg?.model ?? null,
        aiProvider: agg ? providerType : null,
        aiServiceTier: agg ? serviceTier : null,
        aiThinkingLevel: agg ? thinkingLevel : null,
        aiTtftMs: agg?.ttftMs ?? null,
        aiTokens: agg?.completionTokens ?? null,
        aiTotalMs: agg?.totalMs ?? null,
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
