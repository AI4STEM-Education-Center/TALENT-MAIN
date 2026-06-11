// Impure orchestration for the PDF quiz-upload feature: presigns the rasterized
// page images, makes the single vision-LLM extraction call, and persists the
// staged questions back onto the QuizPdfExtraction row. Runs in the background
// worker (decoupled from the upload request, so extraction completes even after
// the teacher navigates away). All DB / LLM / S3 access is concentrated here;
// the pure transforms (schema, prompt, validation, normalization) live in
// `quiz-extraction.ts` and are consumed by this engine.

import type OpenAI from "openai";
import { prisma } from "./prisma";
import { resolveProvider, createOpenAIClient, type ResolvedProvider } from "./ai-provider";
import { presignGetUrl } from "./storage";
import { retryWithExponentialBackoff } from "./retry";
import {
  QUIZ_EXTRACTION_SCHEMA,
  buildExtractionPrompt,
  validateExtractedQuiz,
  normalizeExtractedQuiz,
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

    // Presign a GET URL for every page image, in page order.
    const imageUrls = await Promise.all(
      extraction.pages.map((page) => presignGetUrl(extraction.bucket, page.storageKey, PAGE_URL_EXPIRES_SEC))
    );

    const prompt = buildExtractionPrompt(extraction.totalPages);
    const content = buildExtractionContent(prompt, imageUrls);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "user", content }];

    // Primary path: one strict-json_schema call, wrapped in the shared retry.
    let rawText: string;
    try {
      const response = await retryWithExponentialBackoff(() =>
        client.chat.completions.create({
          model: provider.model,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: QUIZ_EXTRACTION_SCHEMA as never,
          },
          service_tier: tierActive ? (serviceTier as never) : undefined,
        })
      );
      rawText = response.choices?.[0]?.message?.content ?? "";
    } catch (schemaErr) {
      // Fallback: a provider that lacks json_schema support will have thrown
      // above. Retry ONCE without response_format and pull the first JSON
      // object out of the free-text body.
      console.warn(
        `[QuizExtraction] Schema-constrained call failed for ${extractionId}; retrying once without response_format:`,
        schemaErr instanceof Error ? schemaErr.message : schemaErr
      );
      const response = await client.chat.completions.create({
        model: provider.model,
        messages,
        service_tier: tierActive ? (serviceTier as never) : undefined,
      });
      rawText = response.choices?.[0]?.message?.content ?? "";
    }

    if (!rawText.trim()) throw new Error("Model returned an empty extraction response");

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Tolerate models that wrap the JSON in prose even on the primary path.
      parsed = parseFirstJsonObject(rawText);
    }

    const quiz = normalizeExtractedQuiz(validateExtractedQuiz(parsed));

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
