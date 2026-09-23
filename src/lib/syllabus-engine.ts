// Impure orchestration for class-syllabus extraction: resolves the model,
// hands it every page image in one call, and writes the normalized content back
// onto the ClassSyllabus row. Runs in the background worker. The pure half —
// schema, prompt, normalization — lives in `syllabus.ts`.
//
// Revision-pinned: a job carries the revision it was queued for, and every
// write is a compare-and-set on that revision. A teacher who uploads a newer
// version mid-extraction therefore can't have it overwritten by the stale run
// finishing late.

import type OpenAI from "openai";
import { prisma } from "./prisma";
import {
  resolveProvider,
  createOpenAIClient,
  thinkingParams,
  type ResolvedProvider,
} from "./ai-provider";
import { resolveModelImageUrl } from "./storage";
import { moderateImages } from "./guardrails";
import { auditText } from "./guardrail-runner";
import {
  getGuardrailSettings,
  moderationEnabledFor,
} from "./guardrail-settings";
import { retryWithExponentialBackoff } from "./retry";
import {
  streamJsonCompletion,
  aggregateMetrics,
  streamOptionsFor,
  transportFor,
} from "./ai-streaming";
import {
  SYLLABUS_EXTRACTION_SCHEMA,
  buildSyllabusExtractionPrompt,
  extractionWarnings,
  isSyllabusEmpty,
  normalizeSyllabusContent,
  parseStringList,
  syllabusToText,
} from "./syllabus";
import { errorMessage } from "./errors";

const PAGE_URL_EXPIRES_SEC = 3600;

/** EXTRACTING for longer than this means the worker died mid-job. */
export const STALE_SYLLABUS_EXTRACTION_MS = 60 * 60 * 1000;

function providerUsable(
  provider: ResolvedProvider | null,
): provider is ResolvedProvider {
  if (!provider) return false;
  if (provider.providerType !== "local" && !provider.apiKey) return false;
  if (
    (provider.providerType === "local" ||
      provider.providerType === "cloudflare") &&
    !provider.baseUrl
  ) {
    return false;
  }
  return true;
}

/** The syllabus model, falling back to the quiz-PDF model when unassigned. */
async function resolveSyllabusProvider(): Promise<ResolvedProvider | null> {
  const own = await resolveProvider("syllabus_extraction");
  if (providerUsable(own)) return own;
  const fallback = await resolveProvider("quiz_extraction");
  return providerUsable(fallback) ? fallback : null;
}

/**
 * Run extraction for one syllabus revision. Never throws: every failure is
 * recorded on the row as FAILED (unless the row has moved on to a newer
 * revision, in which case this run's outcome is irrelevant), so the worker can
 * ack unconditionally.
 */
export async function runSyllabusExtraction(
  syllabusId: string,
  revision: number,
): Promise<void> {
  const syllabus = await prisma.classSyllabus.findUnique({
    where: { id: syllabusId },
  });
  if (!syllabus) {
    console.warn(`[Syllabus] ${syllabusId} not found; nothing to do`);
    return;
  }
  if (
    syllabus.status !== "EXTRACTING" ||
    syllabus.sourceRevision !== revision
  ) {
    console.log(
      `[Syllabus] ${syllabusId} is ${syllabus.status} at r${syllabus.sourceRevision}, not EXTRACTING r${revision}; skipping`,
    );
    return;
  }

  // Every write below is guarded on this: a newer upload or a teacher discard
  // turns the update into a no-op instead of clobbering it.
  const current = {
    id: syllabus.id,
    status: "EXTRACTING",
    sourceRevision: revision,
  };

  try {
    const provider = await resolveSyllabusProvider();
    if (!provider) {
      await prisma.classSyllabus.updateMany({
        where: current,
        data: {
          status: "FAILED",
          errorMessage:
            "No AI provider is assigned to syllabus extraction. An admin must assign the 'Syllabus PDF Extraction' (or 'Quiz PDF Extraction') use case in AI Config.",
        },
      });
      return;
    }

    const pageKeys = parseStringList(syllabus.pageKeys);
    if (pageKeys.length === 0) throw new Error("The syllabus has no pages.");

    const client = await createOpenAIClient(provider);
    const isLocal = provider.providerType === "local";
    const transport = transportFor(provider);
    const tierActive =
      !isLocal &&
      (provider.serviceTier === "auto" ||
        provider.serviceTier === "default" ||
        provider.serviceTier === "flex");

    // Local providers can't fetch presigned S3 URLs, so their bytes are inlined.
    const imageUrls = await Promise.all(
      pageKeys.map((key) =>
        resolveModelImageUrl(syllabus.bucket, key, {
          inlineBase64: isLocal,
          expiresIn: PAGE_URL_EXPIRES_SEC,
        }),
      ),
    );

    // Audit only, like quiz PDFs: a flagged page is a signal for an admin, not
    // a reason to abandon an extraction the teacher is waiting on.
    const guardrailSettings = await getGuardrailSettings();
    if (moderationEnabledFor(guardrailSettings, "syllabus_page")) {
      void moderateImages(imageUrls, {
        surface: "syllabus_page",
        id: syllabus.id,
      });
    }

    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: buildSyllabusExtractionPrompt(pageKeys.length) },
      ...imageUrls.map(
        (url): OpenAI.Chat.Completions.ChatCompletionContentPart => ({
          type: "image_url",
          image_url: { url },
        }),
      ),
    ];

    const { value, metrics } = await retryWithExponentialBackoff(() =>
      streamJsonCompletion(
        client,
        {
          model: provider.model,
          messages: [{ role: "user", content }],
          service_tier: tierActive
            ? (provider.serviceTier as never)
            : undefined,
          ...thinkingParams(provider),
        },
        SYLLABUS_EXTRACTION_SCHEMA,
        streamOptionsFor(transport),
      ),
    );

    const extracted = normalizeSyllabusContent(value);
    if (isSyllabusEmpty(extracted)) {
      throw new Error(
        "No syllabus information could be read from this PDF. Check that it is a syllabus and that its pages are legible.",
      );
    }
    const warnings = extractionWarnings(value);

    // The extracted text goes on to feed the chat assistant's tools for every
    // student in the class, so it gets the same audit as a quiz PDF. A trip is
    // a warning the teacher reads, not a failure — they can see the content.
    const safety = await auditText(syllabusToText(extracted), {
      surface: "syllabus_extraction",
      id: syllabus.id,
    });
    if (safety.reasons.length > 0) {
      warnings.push(
        `The safety check flagged this document (${safety.reasons.join(", ")}). Review the extracted text before students rely on it.`,
      );
    }

    const agg = aggregateMetrics([metrics]);
    const written = await prisma.classSyllabus.updateMany({
      where: current,
      data: {
        status: "READY",
        errorMessage: null,
        content: JSON.stringify(extracted),
        warnings: JSON.stringify(warnings),
        extractedAt: new Date(),
        editedAt: null,
        aiModel: agg?.model ?? null,
        aiProvider: agg ? provider.providerType : null,
        aiServiceTier: agg ? provider.serviceTier : null,
        aiThinkingLevel: agg ? provider.thinkingLevel : null,
        aiTtftMs: agg?.ttftMs ?? null,
        aiTokens: agg?.completionTokens ?? null,
        aiTotalMs: agg?.totalMs ?? null,
      },
    });
    console.log(
      written.count === 1
        ? `[Syllabus] ${syllabusId} r${revision}: ${extracted.schedule.length} schedule item(s)`
        : `[Syllabus] ${syllabusId} r${revision} superseded before it finished; result dropped`,
    );
  } catch (err) {
    const message = errorMessage(err).trim();
    console.error(`[Syllabus] ${syllabusId} r${revision} failed:`, message);
    await prisma.classSyllabus
      .updateMany({
        where: current,
        data: {
          status: "FAILED",
          errorMessage: message || "Unknown error during syllabus extraction",
        },
      })
      .catch((dbErr: unknown) =>
        console.error(`[Syllabus] Could not mark ${syllabusId} FAILED:`, dbErr),
      );
  }
}

/**
 * Fail extractions whose worker died mid-job, so the teacher sees a retry
 * button instead of a spinner that never ends. Returns how many were failed.
 */
export async function failStaleSyllabusExtractions(
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.classSyllabus.updateMany({
    where: {
      status: "EXTRACTING",
      updatedAt: { lt: new Date(now.getTime() - STALE_SYLLABUS_EXTRACTION_MS) },
    },
    data: {
      status: "FAILED",
      errorMessage: "Extraction timed out. Run it again.",
    },
  });
  return count;
}
