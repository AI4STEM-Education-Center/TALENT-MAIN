// The impure half of the guardrail layer: OpenAI's free /v1/moderations check.
//
// Resolved through the ordinary `resolveProvider("moderation")` assignment, so
// an admin picks the provider and model in the AI Config panel exactly like
// every other use case — and no assignment means the check is simply off.
//
// FAILS OPEN. A guardrail that takes chat down when the moderation endpoint is
// slow is worse than the content it was meant to catch, so every error path
// returns "not checked" and logs. Callers decide what to do with a verdict;
// this module never throws.
//
// The pure fencing helpers live in `guardrail-fence.ts` and are re-exported
// here so callers that need both only import one module.

import { createHash } from "node:crypto";
import {
  resolveProvider,
  createOpenAIClient,
  thinkingParams,
  type ResolvedProvider,
} from "@/lib/ai-provider";
import { streamJsonCompletion, streamOptionsFor, transportFor } from "@/lib/ai-streaming";
import { logSystemEvent } from "@/lib/system-log";
import { chunkForModeration, flaggedCategories, MAX_INPUT_ITEMS } from "@/lib/guardrail-fence";
import {
  GUARDRAIL_CHECK_SCHEMA,
  DEFAULT_GUARDRAIL_POLICY,
  DEFAULT_TOPIC_DESCRIPTION,
  buildGuardrailCheckPrompt,
  validateGuardrailCheck,
  decideAction,
  policyIsInert,
  type GuardrailCheckResult,
  type GuardrailPolicy,
} from "@/lib/guardrail-check";

export {
  DEFAULT_GUARDRAIL_POLICY,
  DEFAULT_TOPIC_DESCRIPTION,
  decideAction,
  isGuardrailMode,
  type GuardrailMode,
  type GuardrailPolicy,
  type GuardrailCheckResult,
} from "@/lib/guardrail-check";

export {
  fenceUntrusted,
  neutralizeUntrusted,
  chunkForModeration,
  flaggedCategories,
  UNTRUSTED_CONTENT_RULE,
  MAX_FENCED_CHARS,
} from "@/lib/guardrail-fence";

// ─── Moderation ──────────────────────────────────────────────────────────────

export interface ModerationVerdict {
  /**
   * Whether the check actually ran. False when no provider is assigned (the
   * feature is off) or the call failed — callers must not read `flagged` as
   * "clean" without this.
   */
  checked: boolean;
  flagged: boolean;
  /** Category names that tripped, e.g. ["violence", "hate"]. Empty when clean. */
  categories: string[];
}

const NOT_CHECKED: ModerationVerdict = { checked: false, flagged: false, categories: [] };

/**
 * Where a moderation call came from. Recorded on the log row so an admin
 * reading /admin/logs can tell a flagged chat message from a flagged PDF page.
 */
export interface GuardrailSubject {
  /** Surface tag, e.g. "assistant_chat", "material_page", "quiz_extraction". */
  surface: string;
  /** Row id the content belongs to, when there is one. */
  id?: string | null;
  userId?: string | null;
}

/**
 * Run the moderation endpoint over already-shaped input.
 *
 * Shared by the text and image entry points. Returns NOT_CHECKED for every
 * failure mode — no assignment, no usable key, a provider that doesn't
 * implement /v1/moderations (most local servers), a timeout — because a
 * moderation outage must not stop a class from uploading material.
 */
async function runModeration(
  input: Parameters<
    Awaited<ReturnType<typeof createOpenAIClient>>["moderations"]["create"]
  >[0]["input"],
  subject: GuardrailSubject,
  describe: string
): Promise<ModerationVerdict> {
  try {
    // Provider resolution touches the database and decrypts credentials, so it
    // belongs inside the same fail-safe boundary as the network call. A lookup
    // failure is an unavailable check, not an exception for callers to handle.
    const provider = await resolveProvider("moderation");
    if (!provider) return NOT_CHECKED;
    if (provider.providerType !== "local" && !provider.apiKey) return NOT_CHECKED;

    const client = await createOpenAIClient(provider);
    const response = await client.moderations.create({ model: provider.model, input });
    const categories = flaggedCategories(response.results ?? []);
    const flagged = categories.length > 0;

    if (flagged) {
      void logSystemEvent({
        category: "GUARDRAIL",
        type: "MODERATION_FLAG",
        severity: "WARNING",
        message: `Moderation flagged ${describe} on ${subject.surface}: ${categories.join(", ")}`,
        userId: subject.userId ?? null,
        metadata: { surface: subject.surface, subjectId: subject.id ?? null, categories },
      });
    }

    return { checked: true, flagged, categories };
  } catch (error) {
    // Logged at INFO, not ERROR: a local provider with no moderation endpoint
    // lands here on every call, and that is a configuration choice rather than
    // a fault worth paging an admin about.
    void logSystemEvent({
      category: "GUARDRAIL",
      type: "MODERATION_UNAVAILABLE",
      severity: "INFO",
      message: `Moderation check skipped on ${subject.surface}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      userId: subject.userId ?? null,
      metadata: { surface: subject.surface, subjectId: subject.id ?? null },
    });
    return NOT_CHECKED;
  }
}

/** Moderate a block of text. Empty/whitespace input is a no-op. */
export async function moderateText(
  text: string,
  subject: GuardrailSubject
): Promise<ModerationVerdict> {
  const chunks = chunkForModeration(text.trim());
  if (chunks.length === 0) return NOT_CHECKED;
  return runModeration(chunks, subject, "text");
}

/**
 * Moderate one or more images by URL. Accepts the same presigned/data URLs the
 * vision models are given, so a page is checked as the model will see it.
 */
export async function moderateImages(
  imageUrls: string[],
  subject: GuardrailSubject
): Promise<ModerationVerdict> {
  const urls = imageUrls.filter((url) => url.trim());
  if (urls.length === 0) return NOT_CHECKED;

  // The endpoint caps one request at MAX_INPUT_ITEMS. Split a long PDF into
  // bounded requests instead of silently leaving every page after the cap
  // unchecked.
  const verdicts = await Promise.all(
    Array.from({ length: Math.ceil(urls.length / MAX_INPUT_ITEMS) }, (_, batchIndex) => {
      const batch = urls.slice(
        batchIndex * MAX_INPUT_ITEMS,
        (batchIndex + 1) * MAX_INPUT_ITEMS
      );
      return runModeration(
        batch.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        subject,
        batch.length === 1 ? "an image" : `${batch.length} images`
      );
    })
  );
  return combineModerationVerdicts(verdicts);
}

/** Combine bounded moderation calls without mistaking partial coverage for clean. */
function combineModerationVerdicts(verdicts: ModerationVerdict[]): ModerationVerdict {
  return {
    checked: verdicts.length > 0 && verdicts.every((verdict) => verdict.checked),
    flagged: verdicts.some((verdict) => verdict.flagged),
    categories: [...new Set(verdicts.flatMap((verdict) => verdict.categories))],
  };
}

/**
 * A content part as the chat models are given it. Mirrors the assistant's own
 * `ContentPart` shape so a turn can be moderated as EXACTLY what the model will
 * see, rather than a re-derived approximation of it.
 */
export type ModerationContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Moderate mixed text/image content in one call.
 *
 * Text parts are joined and chunked; image parts are passed straight through.
 * Text stays first, then the complete item list is split into bounded calls so
 * neither a long attachment nor an image-heavy turn loses its tail.
 */
export async function moderateContent(
  content: string | ModerationContentPart[],
  subject: GuardrailSubject
): Promise<ModerationVerdict> {
  if (typeof content === "string") return moderateText(content, subject);

  const text = content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const images = content.filter(
    (part): part is { type: "image_url"; image_url: { url: string } } =>
      part.type === "image_url" && Boolean(part.image_url?.url?.trim())
  );

  const items = [
    ...chunkForModeration(text).map((chunk) => ({ type: "text" as const, text: chunk })),
    ...images.map((part) => ({ type: "image_url" as const, image_url: { url: part.image_url.url } })),
  ];

  if (items.length === 0) return NOT_CHECKED;
  const verdicts: ModerationVerdict[] = [];
  for (let i = 0; i < items.length; i += MAX_INPUT_ITEMS) {
    verdicts.push(
      await runModeration(
        items.slice(i, i + MAX_INPUT_ITEMS),
        subject,
        images.length > 0 ? "a message with attachments" : "text"
      )
    );
  }
  return combineModerationVerdicts(verdicts);
}

// ─── Jailbreak + off-topic check (one LLM call) ──────────────────────────────

export interface SafetyVerdict {
  /**
   * Whether the check ran. False when no "guardrail" provider is assigned, the
   * policy is inert, or the call failed. As with moderation, `blocked: false`
   * is NOT "clean" unless `checked` is true.
   */
  checked: boolean;
  /** True only when a tripped check is in BLOCK mode. */
  blocked: boolean;
  /** Trip descriptions for the caller's log/message, e.g. ["jailbreak (0.92)"]. */
  reasons: string[];
  /** Raw findings, or null when the check did not run. */
  result: GuardrailCheckResult | null;
}

const NOT_RUN: SafetyVerdict = { checked: false, blocked: false, reasons: [], result: null };

export interface SafetyCheckOptions {
  policy?: GuardrailPolicy;
  /** What counts as on-topic. Defaults to DEFAULT_TOPIC_DESCRIPTION. */
  topicDescription?: string;
}

/**
 * Longest text handed to the classifier. An injection that works has to be
 * readable, and a prefix this long carries any realistic payload — so the cap
 * bounds cost without meaningfully bounding detection.
 */
const MAX_CHECK_CHARS = 12_000;

// Same text checked twice — a worker redelivery, a teacher resubmitting an
// unchanged import — reuses the verdict instead of re-billing. Bounded so a
// busy site cannot grow it without limit; the TTL keeps a policy change from
// being masked by a stale entry for long.
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;
const _checkCache = new Map<string, { verdict: SafetyVerdict; expiresAt: number }>();

/** Cache key: the exact inputs that determine the verdict. */
function cacheKey(text: string, topic: string, policy: GuardrailPolicy, model: string): string {
  return createHash("sha256")
    .update(`${model}\u0000${topic}\u0000${JSON.stringify(policy)}\u0000${text}`)
    .digest("hex");
}

function readCache(key: string): SafetyVerdict | null {
  const hit = _checkCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    _checkCache.delete(key);
    return null;
  }
  return hit.verdict;
}

function writeCache(key: string, verdict: SafetyVerdict): void {
  // Cheapest sound eviction for a Map: insertion order means the first key is
  // the oldest, so dropping it approximates FIFO without a second structure.
  if (_checkCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = _checkCache.keys().next();
    if (!oldest.done) _checkCache.delete(oldest.value);
  }
  _checkCache.set(key, { verdict, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Drop every cached verdict. Called when an admin changes guardrail settings. */
export function invalidateGuardrailCheckCache(): void {
  _checkCache.clear();
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
 * Run the jailbreak + off-topic classifier over one piece of text.
 *
 * ONE call answers both questions — same text, same model, one round trip.
 *
 * FAILS OPEN like the rest of this module: no assignment, an inert policy, an
 * unusable provider, or a thrown call all return `checked: false`, and the
 * caller proceeds. The classifier is a second opinion, not a dependency.
 */
export async function checkContentSafety(
  text: string,
  subject: GuardrailSubject,
  options: SafetyCheckOptions = {}
): Promise<SafetyVerdict> {
  const policy = options.policy ?? DEFAULT_GUARDRAIL_POLICY;
  if (policyIsInert(policy)) return NOT_RUN;

  const trimmed = text.trim().slice(0, MAX_CHECK_CHARS);
  if (!trimmed) return NOT_RUN;

  const provider = await resolveProvider("guardrail");
  if (!providerUsable(provider)) return NOT_RUN;

  const topic = options.topicDescription?.trim() || DEFAULT_TOPIC_DESCRIPTION;
  const key = cacheKey(trimmed, topic, policy, provider.model);
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const client = await createOpenAIClient(provider);
    const transport = transportFor(provider);
    const { value } = await streamJsonCompletion(
      client,
      {
        model: provider.model,
        messages: [{ role: "user", content: buildGuardrailCheckPrompt(trimmed, topic) }],
        ...thinkingParams(provider),
      },
      GUARDRAIL_CHECK_SCHEMA,
      streamOptionsFor(transport)
    );

    const result = validateGuardrailCheck(value);
    const { blocked, reasons } = decideAction(result, policy);
    const verdict: SafetyVerdict = { checked: true, blocked, reasons, result };

    if (reasons.length > 0) {
      void logSystemEvent({
        category: "GUARDRAIL",
        type: blocked ? "SAFETY_BLOCK" : "SAFETY_FLAG",
        severity: "WARNING",
        message: `Guardrail ${blocked ? "blocked" : "flagged"} content on ${subject.surface}: ${reasons.join(", ")}`,
        userId: subject.userId ?? null,
        metadata: {
          surface: subject.surface,
          subjectId: subject.id ?? null,
          reasons,
          jailbreak: result.jailbreak,
          offTopic: result.offTopic,
        },
      });
    }

    writeCache(key, verdict);
    return verdict;
  } catch (error) {
    void logSystemEvent({
      category: "GUARDRAIL",
      type: "SAFETY_CHECK_UNAVAILABLE",
      severity: "INFO",
      message: `Safety check skipped on ${subject.surface}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      userId: subject.userId ?? null,
      metadata: { surface: subject.surface, subjectId: subject.id ?? null },
    });
    return NOT_RUN;
  }
}
