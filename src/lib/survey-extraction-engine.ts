// Worker-side AI pass that turns an uploaded survey PDF's text into editable
// questions. The upload route already stored a heuristic first draft (see
// parseSurveyText), so a failure here leaves the admin with that draft and an
// error message rather than an empty form.

import { prisma } from "./prisma";
import {
  resolveProvider,
  createOpenAIClient,
  thinkingParams,
  type ResolvedProvider,
} from "./ai-provider";
import { retryWithExponentialBackoff } from "./retry";
import {
  streamJsonCompletion,
  streamOptionsFor,
  transportFor,
} from "./ai-streaming";
import {
  SURVEY_EXTRACTION_SCHEMA,
  buildSurveyExtractionPrompt,
  normalizeExtractedSurvey,
} from "./survey";
import { errorMessage } from "./errors";

/** EXTRACTING for longer than this means the worker died mid-job. */
export const STALE_SURVEY_EXTRACTION_MS = 30 * 60 * 1000;

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

/** The survey model, falling back to the quiz-PDF model when unassigned. */
export async function resolveSurveyProvider(): Promise<ResolvedProvider | null> {
  const own = await resolveProvider("survey_extraction");
  if (providerUsable(own)) return own;
  const fallback = await resolveProvider("quiz_extraction");
  return providerUsable(fallback) ? fallback : null;
}

/** Never throws: outcomes are recorded on the form row. */
export async function runSurveyExtraction(formId: string): Promise<void> {
  const form = await prisma.surveyForm.findUnique({ where: { id: formId } });
  if (!form || form.status !== "EXTRACTING") return;
  const current = { id: form.id, status: "EXTRACTING" };

  try {
    if (!form.sourceText?.trim())
      throw new Error("The uploaded PDF had no readable text.");
    const provider = await resolveSurveyProvider();
    if (!provider)
      throw new Error(
        "No AI provider is assigned to survey extraction. The questions below were read without AI — review them, or assign 'Research Survey PDF Extraction' in AI Config and run it again.",
      );

    const client = await createOpenAIClient(provider);
    const isLocal = provider.providerType === "local";
    const tierActive =
      !isLocal &&
      (provider.serviceTier === "auto" ||
        provider.serviceTier === "default" ||
        provider.serviceTier === "flex");

    const { value } = await retryWithExponentialBackoff(() =>
      streamJsonCompletion(
        client,
        {
          model: provider.model,
          messages: [
            {
              role: "user",
              content: buildSurveyExtractionPrompt(form.sourceText ?? ""),
            },
          ],
          service_tier: tierActive
            ? (provider.serviceTier as never)
            : undefined,
          ...thinkingParams(provider),
        },
        SURVEY_EXTRACTION_SCHEMA,
        streamOptionsFor(transportFor(provider)),
      ),
    );

    const extracted = normalizeExtractedSurvey(value);
    if (extracted.questions.filter((q) => q.type !== "section").length === 0)
      throw new Error(
        "The AI could not find any questions in this PDF. The draft below was read without AI.",
      );

    await prisma.surveyForm.updateMany({
      where: current,
      data: {
        status: "READY",
        errorMessage: null,
        questions: JSON.stringify(extracted.questions),
        ...(extracted.title ? { title: extracted.title } : {}),
        ...(extracted.description
          ? { description: extracted.description }
          : {}),
      },
    });
  } catch (err) {
    const message = errorMessage(err).trim() || "Survey extraction failed.";
    console.error(`[Survey] ${formId} extraction failed:`, message);
    // Back to READY with the heuristic draft intact; the message explains.
    await prisma.surveyForm
      .updateMany({
        where: current,
        data: { status: "READY", errorMessage: message.slice(0, 1000) },
      })
      .catch((dbErr: unknown) =>
        console.error(
          `[Survey] Could not record failure for ${formId}:`,
          dbErr,
        ),
      );
  }
}

/** Release forms whose extraction worker died, keeping their heuristic draft. */
export async function failStaleSurveyExtractions(
  now: Date = new Date(),
): Promise<number> {
  const { count } = await prisma.surveyForm.updateMany({
    where: {
      status: "EXTRACTING",
      updatedAt: { lt: new Date(now.getTime() - STALE_SURVEY_EXTRACTION_MS) },
    },
    data: {
      status: "READY",
      errorMessage:
        "AI extraction timed out. The questions below were read without AI.",
    },
  });
  return count;
}
