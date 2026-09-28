import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createOpenAIClient, resolveProvider } from "@/lib/ai-provider";
import {
  chunkForModeration,
  flaggedCategories,
  isModerationModel,
  moderationEndpointUnsupported,
} from "@/lib/guardrail-fence";
import { logApiError } from "@/lib/system-log";
import { errorMessage } from "@/lib/errors";

export const runtime = "nodejs";

/** Longest sample accepted — well past one chunk, short of a PDF's worth. */
const MAX_SAMPLE_CHARS = 8000;

/** How many of the highest category scores the panel shows. */
const TOP_SCORES = 6;

/**
 * Highest score per category across every chunk's result, highest first. The
 * endpoint scores each chunk separately, so a long sample is judged by its worst
 * part — the same way a flag on any chunk flags the whole submission.
 */
function topScores(results: readonly unknown[]) {
  const best = new Map<string, number>();
  for (const result of results) {
    const scores = (result as { category_scores?: unknown } | null)
      ?.category_scores;
    if (!scores || typeof scores !== "object") continue;
    for (const [name, score] of Object.entries(scores)) {
      if (typeof score !== "number") continue;
      best.set(name, Math.max(best.get(name) ?? 0, score));
    }
  }
  return [...best]
    .map(([category, score]) => ({ category, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_SCORES);
}

/**
 * POST /api/admin/guardrails/moderation-test
 * Body: { text: string }
 *
 * Runs admin-supplied text through content moderation exactly as a chat message
 * or PDF page would be — the same assignment, client, chunking and flag rule as
 * src/lib/guardrails.ts — and reports the verdict with its category scores.
 *
 * The connection test on the use-case table only proves the endpoint answers a
 * benign string. This answers the question an admin actually has: would THIS
 * content be caught? Unlike the runtime path it does not fail open: every
 * reason the check would silently not run is reported, and nothing is written
 * to the guardrail log, so testing never shows up as a real flag.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let text: string;
  try {
    const body = await req.json();
    text = typeof body?.text === "string" ? body.text.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json(
      { error: "Enter some text to moderate." },
      { status: 400 },
    );
  }
  if (text.length > MAX_SAMPLE_CHARS) {
    return NextResponse.json(
      { error: `Keep the sample under ${MAX_SAMPLE_CHARS} characters.` },
      { status: 400 },
    );
  }

  try {
    const provider = await resolveProvider("moderation");
    if (!provider) {
      return NextResponse.json({
        success: false,
        error:
          "Content Moderation is not assigned, so nothing is checked. Assign " +
          "a moderation model in the use-case table above.",
      });
    }
    // Mirrors runModeration: without a key the runtime skips the check.
    if (provider.providerType !== "local" && !provider.apiKey) {
      return NextResponse.json({
        success: false,
        error:
          "The assigned provider has no API key, so moderation is skipped on " +
          "every real message.",
      });
    }

    const client = await createOpenAIClient(provider);
    const startedAt = Date.now();
    let response;
    try {
      response = await client.moderations.create({
        model: provider.model,
        input: chunkForModeration(text),
      });
    } catch (error) {
      const raw = errorMessage(error) || "the call failed";
      const hint = moderationEndpointUnsupported(error)
        ? "This provider does not implement /v1/moderations, so moderation " +
          "never runs on it. "
        : !isModerationModel(provider.model)
          ? `${provider.model} is a chat model, not a moderation model. `
          : "";
      return NextResponse.json({
        success: false,
        error: `${hint}Provider said: ${raw}`,
      });
    }

    const results = response.results ?? [];
    const categories = flaggedCategories(results);
    return NextResponse.json({
      success: true,
      flagged: categories.length > 0,
      categories,
      scores: topScores(results),
      latencyMs: Date.now() - startedAt,
      model: provider.model,
      providerType: provider.providerType,
    });
  } catch (error) {
    logApiError("GUARDRAIL_MODERATION_TEST", error);
    return NextResponse.json({
      success: false,
      error: errorMessage(error) || "Moderation test failed",
    });
  }
}
