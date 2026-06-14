// Impure orchestration for the PDF quiz-upload feature: presigns the rasterized
// page images, makes the vision-LLM extraction call(s), and persists the staged
// questions back onto the QuizPdfExtraction row. Runs in the background worker
// (decoupled from the upload request, so extraction completes even after the
// teacher navigates away). All DB / LLM / S3 access is concentrated here; the
// pure transforms (schemas, prompts, validation, normalization, localization)
// live in `quiz-extraction.ts` and are consumed by this engine.
//
// Extraction is two-pass: pass 1 identifies every question (text, options,
// answer key) over all pages and flags figures / image answer-choices; pass 2
// runs ONLY when something needs a tight crop box, doing one focused
// localization call per page and merging the boxes back. A text-only quiz makes
// exactly one call, unchanged from before.

import type OpenAI from "openai";
import { prisma } from "./prisma";
import { resolveProvider, createOpenAIClient, type ResolvedProvider } from "./ai-provider";
import { resolveModelImageUrl } from "./storage";
import { retryWithExponentialBackoff } from "./retry";
import {
  QUIZ_EXTRACTION_SCHEMA,
  QUIZ_LOCALIZATION_SCHEMA,
  buildExtractionPrompt,
  buildLocalizationPrompt,
  validateExtractedQuiz,
  normalizeExtractedQuiz,
  needsLocalization,
  collectLocalizationTargets,
  groupTargetsByPage,
  validateLocalizationResult,
  mergeLocalizedBoxes,
  type LocalizedBox,
} from "./quiz-extraction";

const PAGE_URL_EXPIRES_SEC = 3600;

function providerUsable(provider: ResolvedProvider | null): provider is ResolvedProvider {
  if (!provider) return false;
  if (provider.providerType !== "local" && !provider.apiKey) return false;
  if ((provider.providerType === "local" || provider.providerType === "cloudflare") && !provider.baseUrl) {
    return false;
  }
  return true;
}

/**
 * Extract the first balanced-looking JSON object from a free-text response.
 * Replicated from `exam-results-engine.ts` (where it is a private helper) so the
 * fallback path here does not have to import from a sibling impure engine.
 */
function parseFirstJsonObject(content: string): unknown {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in model response");
  return JSON.parse(match[0]);
}

/** Build the multimodal user-message content: the prompt text + one image per page (in order). */
function buildExtractionContent(prompt: string, imageUrls: string[]): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  return [
    { type: "text", text: prompt },
    ...imageUrls.map(
      (url): OpenAI.Chat.Completions.ChatCompletionContentPart => ({ type: "image_url", image_url: { url } })
    ),
  ];
}

/** Build the localization message content: the prompt text + a single page image. */
function buildLocalizationContent(prompt: string, pageImageUrl: string): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  return [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: pageImageUrl } },
  ];
}

type ModelCallOptions = {
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  schema: unknown;
  serviceTier: string | null;
  tierActive: boolean;
};

/**
 * One strict-json_schema chat call (wrapped in the shared retry), returning the
 * parsed JSON. A provider that lacks json_schema support throws on the primary
 * path, so we retry ONCE without response_format and pull the first JSON object
 * out of the free-text body. Shared by both extraction passes. Throws on an
 * empty response (callers decide whether that is fatal).
 */
async function callJsonModel(client: OpenAI, opts: ModelCallOptions): Promise<unknown> {
  const { model, messages, schema, serviceTier, tierActive } = opts;
  let rawText: string;
  try {
    const response = await retryWithExponentialBackoff(() =>
      client.chat.completions.create({
        model,
        messages,
        response_format: { type: "json_schema", json_schema: schema as never },
        service_tier: tierActive ? (serviceTier as never) : undefined,
      })
    );
    rawText = response.choices?.[0]?.message?.content ?? "";
  } catch (schemaErr) {
    console.warn(
      `[QuizExtraction] Schema-constrained call failed; retrying once without response_format:`,
      schemaErr instanceof Error ? schemaErr.message : schemaErr
    );
    const response = await client.chat.completions.create({
      model,
      messages,
      service_tier: tierActive ? (serviceTier as never) : undefined,
    });
    rawText = response.choices?.[0]?.message?.content ?? "";
  }

  if (!rawText.trim()) throw new Error("Model returned an empty response");

  try {
    return JSON.parse(rawText);
  } catch {
    // Tolerate models that wrap the JSON in prose even on the primary path.
    return parseFirstJsonObject(rawText);
  }
}

/**
 * Run vision-LLM extraction for one uploaded quiz PDF and persist the result.
 *
 * Idempotent + self-healing: only acts on rows in the EXTRACTING state (the
 * retry route resets status to EXTRACTING before re-enqueueing), so Honker job
 * redelivery after a worker restart is safe. Environment gaps (missing row, no
 * provider) and any thrown error are recorded on the row as FAILED and the
 * function RETURNS — it never rethrows, so the worker can ack unconditionally.
 */
export async function runQuizExtraction(extractionId: string): Promise<void> {
  const extraction = await prisma.quizPdfExtraction.findUnique({
    where: { id: extractionId },
    include: { pages: { orderBy: { pageNumber: "asc" } } },
  });

  if (!extraction) {
    console.warn(`[QuizExtraction] Extraction ${extractionId} not found; nothing to do`);
    return;
  }

  // Idempotency guard: only the EXTRACTING state is actionable. Anything else
  // (already AWAITING_REVIEW/COMMITTED/FAILED, or still PENDING_UPLOAD) means a
  // stale redelivery — log and bail without touching the row.
  if (extraction.status !== "EXTRACTING") {
    console.log(
      `[QuizExtraction] Extraction ${extractionId} is in status ${extraction.status}, not EXTRACTING; skipping`
    );
    return;
  }

  try {
    const provider = await resolveProvider("quiz_extraction");
    if (!providerUsable(provider)) {
      await prisma.quizPdfExtraction.update({
        where: { id: extraction.id },
        data: {
          status: "FAILED",
          errorMessage:
            "No AI provider assigned to quiz_extraction. An admin must configure the 'quiz_extraction' use case in the AI Config dashboard.",
        },
      });
      console.error(`[QuizExtraction] No usable provider for extraction ${extractionId}`);
      return;
    }

    const client = await createOpenAIClient(provider);
    const isLocal = provider.providerType === "local";
    const serviceTier = provider.serviceTier;
    const tierActive =
      !isLocal && (serviceTier === "auto" || serviceTier === "default" || serviceTier === "flex");

    // Resolve a model-ready URL for every page image, in page order (index i →
    // page i+1). Local providers can't fetch our presigned S3 URLs, so their
    // bytes are inlined as base64 data URLs; hosted providers get short-lived
    // presigned links. buildExtractionContent / buildLocalizationContent embed
    // whichever string they receive, so both passes are covered by this choice.
    const imageUrls = await Promise.all(
      extraction.pages.map((page) =>
        resolveModelImageUrl(extraction.bucket, page.storageKey, {
          inlineBase64: isLocal,
          expiresIn: PAGE_URL_EXPIRES_SEC,
        })
      )
    );
    const pageNumbers = extraction.pages.map((p) => p.pageNumber);

    // ── Pass 1: identify questions / options / answer key over all pages. ──
    const pass1Prompt = buildExtractionPrompt(extraction.totalPages);
    const pass1Messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "user", content: buildExtractionContent(pass1Prompt, imageUrls) },
    ];
    const pass1Parsed = await callJsonModel(client, {
      model: provider.model,
      messages: pass1Messages,
      schema: QUIZ_EXTRACTION_SCHEMA,
      serviceTier,
      tierActive,
    });
    let quiz = normalizeExtractedQuiz(validateExtractedQuiz(pass1Parsed));

    // ── Pass 2: tight bounding boxes — only when something needs cropping. ──
    // Best-effort: any failure (whole block or a single page) leaves the
    // pass-1/coarse boxes in place rather than failing the extraction.
    if (needsLocalization(quiz)) {
      try {
        const byPage = groupTargetsByPage(collectLocalizationTargets(quiz));
        const boxes: LocalizedBox[] = [];
        for (const [pageNumber, targets] of byPage) {
          const idx = pageNumbers.indexOf(pageNumber);
          if (idx === -1) {
            console.warn(
              `[QuizExtraction] ${extractionId}: page ${pageNumber} has no image; skipping ${targets.length} target(s)`
            );
            continue;
          }
          try {
            const locMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
              { role: "user", content: buildLocalizationContent(buildLocalizationPrompt(pageNumber, targets), imageUrls[idx]) },
            ];
            const locParsed = await callJsonModel(client, {
              model: provider.model,
              messages: locMessages,
              schema: QUIZ_LOCALIZATION_SCHEMA,
              serviceTier,
              tierActive,
            });
            const known = new Set(targets.map((t) => t.targetId));
            boxes.push(...validateLocalizationResult(locParsed, known));
          } catch (pageErr) {
            console.warn(
              `[QuizExtraction] ${extractionId}: localization failed for page ${pageNumber}:`,
              pageErr instanceof Error ? pageErr.message : pageErr
            );
          }
        }
        quiz = mergeLocalizedBoxes(quiz, boxes);
      } catch (locErr) {
        console.warn(
          `[QuizExtraction] ${extractionId}: pass-2 localization aborted; using coarse boxes:`,
          locErr instanceof Error ? locErr.message : locErr
        );
      }
    }

    await prisma.quizPdfExtraction.update({
      where: { id: extraction.id },
      data: {
        extractedQuestions: JSON.stringify(quiz.questions),
        hasAnswerKey: quiz.hasAnswerKey,
        warnings: JSON.stringify(quiz.warnings),
        status: "AWAITING_REVIEW",
        errorMessage: null,
      },
    });
    console.log(
      `[QuizExtraction] Extraction ${extractionId} complete: ${quiz.questions.length} question(s), hasAnswerKey=${quiz.hasAnswerKey}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message.trim() : String(err).trim();
    console.error(`[QuizExtraction] Extraction ${extractionId} failed:`, message);
    try {
      await prisma.quizPdfExtraction.update({
        where: { id: extraction.id },
        data: {
          status: "FAILED",
          errorMessage: message || "Unknown error during quiz extraction",
        },
      });
    } catch (dbErr) {
      console.error(`[QuizExtraction] Could not mark extraction ${extractionId} FAILED:`, dbErr);
    }
    return;
  }
}
