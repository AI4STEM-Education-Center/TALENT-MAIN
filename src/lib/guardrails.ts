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
  DEFAULT_GUARDRAIL_POLICY,
  DEFAULT_TOPIC_DESCRIPTION,
  activeChecks,
  buildGuardrailCheckPrompt,
  guardrailCheckResponseIsComplete,
  decideAction,
  emptyCheckResult,
  guardrailCheckSchema,
  policyIsInert,
  validateGuardrailCheck,
  type CheckSelection,
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

// ─── Jailbreak + off-topic check ─────────────────────────────────────────────
//
// The two checks carry INDEPENDENT model assignments ("guardrail_jailbreak" and
// "guardrail_offtopic"), so how many calls a check costs depends on how the
// admin configured it:
//
//   both on, same model      → 1 call asking both questions
//   both on, different models→ 2 calls, each asking its own question
//   one on                   → 1 call asking that one question
//   neither on / unassigned  → 0 calls
//
// Sharing a model is therefore the cheap default and splitting is a deliberate
// choice, which is exactly the trade-off the admin panel presents.

export interface SafetyVerdict {
  /**
   * Whether EVERY check the policy switched on actually ran. False when a
   * check has no provider assigned, the policy is inert, or a call failed —
   * including the half-failure where one of two models answered and the other
   * did not. As with moderation, `blocked: false` is NOT "clean" unless
   * `checked` is true.
   */
  checked: boolean;
  /** True only when a tripped check is in BLOCK mode. */
  blocked: boolean;
  /** Trip descriptions for the caller's log/message, e.g. ["jailbreak (0.92)"]. */
  reasons: string[];
  /** Findings from whichever checks answered, or null when none did. */
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
const MAX_CHECK_CALLS = 16;

/**
 * Cover ordinary inputs completely. Pathological inputs are sampled evenly
 * from beginning to end and reported as partial (`checked: false`) so a
 * fail-closed caller never mistakes sampling for complete coverage.
 */
function checkChunks(text: string): { chunks: string[]; complete: boolean } {
  if (text.length <= MAX_CHECK_CHARS) return { chunks: [text], complete: true };

  const totalChunks = Math.ceil(text.length / MAX_CHECK_CHARS);
  if (totalChunks <= MAX_CHECK_CALLS) {
    return {
      chunks: Array.from({ length: totalChunks }, (_, index) =>
        text.slice(index * MAX_CHECK_CHARS, (index + 1) * MAX_CHECK_CHARS)
      ),
      complete: true,
    };
  }

  const lastStart = text.length - MAX_CHECK_CHARS;
  return {
    chunks: Array.from({ length: MAX_CHECK_CALLS }, (_, index) => {
      const start = Math.round((lastStart * index) / (MAX_CHECK_CALLS - 1));
      return text.slice(start, start + MAX_CHECK_CHARS);
    }),
    complete: false,
  };
}

function mergeCheckResults(results: GuardrailCheckResult[]): GuardrailCheckResult {
  const strongest = (key: "jailbreak" | "offTopic") =>
    results.reduce(
      (best, result) => {
        const candidate = result[key];
        if (candidate.detected !== best.detected) return candidate.detected ? candidate : best;
        return candidate.confidence > best.confidence ? candidate : best;
      },
      results[0][key]
    );
  return { jailbreak: strongest("jailbreak"), offTopic: strongest("offTopic") };
}

// Same text checked twice — a worker redelivery, a teacher resubmitting an
// unchanged import — reuses the FINDINGS instead of re-billing. Thresholds and
// modes are applied after the cache rather than baked into the key, so an admin
// retuning a threshold re-reads a cached answer rather than paying for the same
// classification again. Bounded so a busy site cannot grow it without limit.
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;
const _checkCache = new Map<string, { result: GuardrailCheckResult; expiresAt: number }>();

/**
 * Everything about a resolved provider that changes what a call returns. Two
 * use cases resolving to the same values are the same call and are merged; a
 * difference anywhere — a different model, endpoint or reasoning effort —
 * means two calls.
 */
function providerKey(provider: ResolvedProvider): string {
  return JSON.stringify([
    provider.providerType,
    provider.baseUrl,
    provider.apiKey,
    provider.cfAigByokAlias,
    provider.model,
    provider.apiSurface,
    provider.thinkingLevel,
    provider.serviceTier,
  ]);
}

/** Cache key: the exact inputs that determine the findings. */
function cacheKey(text: string, topic: string, checks: CheckSelection, provider: string): string {
  const asked = `${checks.jailbreak ? "j" : ""}${checks.offTopic ? "o" : ""}`;
  return createHash("sha256")
    .update(`${provider}\u0000${asked}\u0000${topic}\u0000${text}`)
    .digest("hex");
}

function readCache(key: string): GuardrailCheckResult | null {
  const hit = _checkCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    _checkCache.delete(key);
    return null;
  }
  return hit.result;
}

function writeCache(key: string, result: GuardrailCheckResult): void {
  // Cheapest sound eviction for a Map: insertion order means the first key is
  // the oldest, so dropping it approximates FIFO without a second structure.
  if (_checkCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = _checkCache.keys().next();
    if (!oldest.done) _checkCache.delete(oldest.value);
  }
  _checkCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Drop every cached finding. Called when an admin changes guardrail settings. */
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

/** One planned model call: the questions it asks and the provider it asks them on. */
interface CheckCall {
  checks: CheckSelection;
  provider: ResolvedProvider;
}

/**
 * Decide which calls to make. Exported for the tests, which assert the merging
 * rule directly rather than inferring it from call counts.
 */
export function planCheckCalls(
  wanted: CheckSelection,
  jailbreakProvider: ResolvedProvider | null,
  offTopicProvider: ResolvedProvider | null
): CheckCall[] {
  const jailbreak = wanted.jailbreak && providerUsable(jailbreakProvider) ? jailbreakProvider : null;
  const offTopic = wanted.offTopic && providerUsable(offTopicProvider) ? offTopicProvider : null;

  // Same model, both questions: one call. This is the configuration the panel
  // recommends, and it costs exactly what asking a single question costs.
  if (jailbreak && offTopic && providerKey(jailbreak) === providerKey(offTopic)) {
    return [{ checks: { jailbreak: true, offTopic: true }, provider: jailbreak }];
  }

  const calls: CheckCall[] = [];
  if (jailbreak) calls.push({ checks: { jailbreak: true, offTopic: false }, provider: jailbreak });
  if (offTopic) calls.push({ checks: { jailbreak: false, offTopic: true }, provider: offTopic });
  return calls;
}

/**
 * Run one planned call. Returns null when it could not produce findings, which
 * the caller reads as "this call's checks did not run" — never as "clean".
 */
async function runCheckCall(
  call: CheckCall,
  text: string,
  topic: string,
  subject: GuardrailSubject
): Promise<{ result: GuardrailCheckResult; complete: boolean } | null> {
  try {
    const client = await createOpenAIClient(call.provider);
    const transport = transportFor(call.provider);
    const planned = checkChunks(text);
    const results = await Promise.all(
      planned.chunks.map(async (chunk) => {
        const key = cacheKey(chunk, topic, call.checks, providerKey(call.provider));
        const cached = readCache(key);
        if (cached) return cached;

        const { value } = await streamJsonCompletion(
          client,
          {
            model: call.provider.model,
            messages: [
              { role: "user", content: buildGuardrailCheckPrompt(chunk, topic, call.checks) },
            ],
            ...thinkingParams(call.provider),
          },
          guardrailCheckSchema(call.checks),
          streamOptionsFor(transport)
        );
        if (!guardrailCheckResponseIsComplete(value, call.checks)) {
          throw new Error("Guardrail classifier returned an incomplete response.");
        }

        const result = validateGuardrailCheck(value, call.checks);
        writeCache(key, result);
        return result;
      })
    );

    if (!planned.complete) {
      void logSystemEvent({
        category: "GUARDRAIL",
        type: "SAFETY_CHECK_PARTIAL",
        severity: "INFO",
        message: `Safety check sampled oversized content on ${subject.surface}; complete coverage was not possible.`,
        userId: subject.userId ?? null,
        metadata: {
          surface: subject.surface,
          subjectId: subject.id ?? null,
          length: text.length,
          model: call.provider.model,
          checks: call.checks,
        },
      });
    }

    return { result: mergeCheckResults(results), complete: planned.complete };
  } catch (error) {
    void logSystemEvent({
      category: "GUARDRAIL",
      type: "SAFETY_CHECK_UNAVAILABLE",
      severity: "INFO",
      message: `Safety check skipped on ${subject.surface} (${call.provider.model}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      userId: subject.userId ?? null,
      metadata: {
        surface: subject.surface,
        subjectId: subject.id ?? null,
        model: call.provider.model,
        checks: call.checks,
      },
    });
    return null;
  }
}

/**
 * Run the jailbreak and off-topic classifiers over one piece of text, on
 * whichever models the admin assigned to each.
 *
 * FAILS OPEN like the rest of this module: no assignment, an inert policy, an
 * unusable provider, or a thrown call all leave `checked: false`, and the
 * caller proceeds. The classifier is a second opinion, not a dependency.
 */
export async function checkContentSafety(
  text: string,
  subject: GuardrailSubject,
  options: SafetyCheckOptions = {}
): Promise<SafetyVerdict> {
  const policy = options.policy ?? DEFAULT_GUARDRAIL_POLICY;
  if (policyIsInert(policy)) return NOT_RUN;

  const trimmed = text.trim();
  if (!trimmed) return NOT_RUN;

  try {
    // Provider resolution can fail on a database read or credential decrypt;
    // keep it inside the fail-safe boundary just like the model request.
    const wanted = activeChecks(policy);
    const [jailbreakProvider, offTopicProvider] = await Promise.all([
      wanted.jailbreak ? resolveProvider("guardrail_jailbreak") : Promise.resolve(null),
      wanted.offTopic ? resolveProvider("guardrail_offtopic") : Promise.resolve(null),
    ]);

    const calls = planCheckCalls(wanted, jailbreakProvider, offTopicProvider);
    if (calls.length === 0) return NOT_RUN;

    const answers = await Promise.all(
      calls.map((call) => runCheckCall(call, trimmed, topicFor(options), subject))
    );

    // A finding is only taken from the call that actually asked for it, so a
    // model volunteering an answer to the other question is ignored.
    const result = emptyCheckResult();
    const ran: CheckSelection = { jailbreak: false, offTopic: false };
    let complete = true;
    calls.forEach((call, index) => {
      const answer = answers[index];
      if (!answer) return;
      complete = complete && answer.complete;
      if (call.checks.jailbreak) {
        result.jailbreak = answer.result.jailbreak;
        ran.jailbreak = true;
      }
      if (call.checks.offTopic) {
        result.offTopic = answer.result.offTopic;
        ran.offTopic = true;
      }
    });

    // Partial provider or document coverage is NOT a pass: fail-closed sites
    // must not mistake either condition for a clean bill of health.
    const checked =
      complete &&
      (!wanted.jailbreak || ran.jailbreak) &&
      (!wanted.offTopic || ran.offTopic);
    if (!ran.jailbreak && !ran.offTopic) return NOT_RUN;

    const { blocked, reasons } = decideAction(result, policy);

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
          models: calls.map((call) => call.provider.model),
        },
      });
    }

    return { checked, blocked, reasons, result };
  } catch (error) {
    void logSystemEvent({
      category: "GUARDRAIL",
      type: "SAFETY_CHECK_UNAVAILABLE",
      severity: "INFO",
      message: `Safety check setup failed on ${subject.surface}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      userId: subject.userId ?? null,
      metadata: { surface: subject.surface, subjectId: subject.id ?? null },
    });
    return NOT_RUN;
  }
}

function topicFor(options: SafetyCheckOptions): string {
  return options.topicDescription?.trim() || DEFAULT_TOPIC_DESCRIPTION;
}
