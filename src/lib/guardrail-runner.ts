// The one entry point call sites use: load the admin's settings, run the free
// moderation pass and the LLM check under them, and return a single decision.
//
// Sits above both halves so neither has to know about the other —
// `guardrail-settings.ts` reads the row, `guardrails.ts` makes the calls, and
// this module is the only place that knows how they combine. That is also what
// keeps the import graph acyclic.
//
// Every call site gets the same three behaviours for free: a disabled surface
// short-circuits before anything is billed, `failOpen: false` turns "the check
// could not run" into a rejection on request paths, and the user-facing message
// never leaks which check tripped or why.

import {
  moderateContent,
  moderateText,
  checkContentSafety,
  type GuardrailSubject,
  type ModerationContentPart,
} from "@/lib/guardrails";
import {
  getGuardrailSettings,
  moderationEnabledFor,
  policyFor,
  type GuardrailSettings,
} from "@/lib/guardrail-settings";
import { recordGuardrailEvent } from "@/lib/guardrail-events";

export interface GuardDecision {
  /** True when the caller must refuse the submission. */
  blocked: boolean;
  /** A sentence for the end user. Deliberately vague — details go to the log. */
  message: string | null;
  /** Trip descriptions for the caller's own logging. Never shown to a user. */
  reasons: string[];
  /**
   * Id of the recorded finding, to hand to the user alongside the message so
   * they can report it as wrong. Null when nothing tripped, or when the record
   * could not be written — callers must treat it as optional and simply omit
   * the report button.
   */
  eventId: string | null;
}

const ALLOWED: GuardDecision = {
  blocked: false,
  message: null,
  reasons: [],
  eventId: null,
};

/**
 * A decision before it has been recorded. `record` is explicit rather than
 * inferred from `blocked`, because the two diverge: a check that could not RUN
 * blocks without being a finding anyone can disagree with, and a FLAG-only trip
 * is a finding without blocking.
 */
type PendingDecision = GuardDecision & { record: boolean };

const BLOCKED_MESSAGE =
  "This content was blocked by the site's safety checks. Please review the wording and try again.";
const UNAVAILABLE_MESSAGE =
  "The site's safety checks are unavailable right now, so this could not be submitted. Please try again shortly.";

export interface GuardOptions {
  /**
   * True for a user-facing request that can be retried, false for a background
   * worker job.
   *
   * Only request paths honour `failOpen: false`. Failing a worker job closed
   * would strand an upload the teacher is waiting on, with no way for them to
   * re-run the check — so PDF processing stays fail-open regardless of the
   * setting, and reports instead.
   */
  requestPath?: boolean;
  /** Pre-loaded settings, when the caller already read them this request. */
  settings?: GuardrailSettings;
}

function decide(
  moderationRan: boolean,
  moderationFlagged: boolean,
  safetyRan: boolean,
  safetyBlocked: boolean,
  reasons: string[],
  settings: GuardrailSettings,
  options: GuardOptions,
  expected: { moderation: boolean; safety: boolean },
): PendingDecision {
  if (moderationFlagged || safetyBlocked) {
    return {
      // Background/audit paths report the finding but deliberately continue.
      blocked: options.requestPath !== false,
      message: BLOCKED_MESSAGE,
      reasons,
      eventId: null,
      record: true,
    };
  }

  // Fail-closed: a check that was supposed to run but couldn't is a refusal
  // rather than a silent pass. Only ever applied on request paths.
  if (!settings.failOpen && options.requestPath) {
    if (
      (expected.moderation && !moderationRan) ||
      (expected.safety && !safetyRan)
    ) {
      // Not recorded: there is nothing here for a user to disagree with, and an
      // outage in the review queue is noise that buries the real reports.
      return {
        blocked: true,
        message: UNAVAILABLE_MESSAGE,
        reasons: ["check unavailable"],
        eventId: null,
        record: false,
      };
    }
  }

  // Nothing blocked, but a FLAG-only trip still produced reasons a teacher will
  // read as a warning — so it is recorded and can be argued with.
  return {
    blocked: false,
    message: null,
    reasons,
    eventId: null,
    record: reasons.length > 0,
  };
}

/**
 * Record a finding the user is about to be shown and stamp its id onto the
 * decision, dropping the internal `record` marker on the way out.
 */
async function withEvent(
  pending: PendingDecision,
  subject: GuardrailSubject,
): Promise<GuardDecision> {
  const { record, ...decision } = pending;
  if (!record) return decision;
  const eventId = await recordGuardrailEvent({
    surface: subject.surface,
    subjectId: subject.id ?? null,
    userId: subject.userId ?? null,
    blocked: decision.blocked,
    reasons: decision.reasons,
  });
  return { ...decision, eventId };
}

/**
 * Guard a block of text: free moderation plus the jailbreak/off-topic check,
 * run concurrently under the admin's current settings.
 */
export async function guardText(
  text: string,
  subject: GuardrailSubject,
  options: GuardOptions = {},
): Promise<GuardDecision> {
  const settings = options.settings ?? (await getGuardrailSettings());
  const policy = policyFor(settings, subject.surface);
  const runModeration = moderationEnabledFor(settings, subject.surface);

  const [moderation, safety] = await Promise.all([
    runModeration
      ? moderateText(text, subject)
      : Promise.resolve({ checked: false, flagged: false, categories: [] }),
    checkContentSafety(text, subject, {
      policy,
      topicDescription: settings.topicDescription,
    }),
  ]);

  const reasons = [
    ...moderation.categories.map((category) => `moderation:${category}`),
    ...safety.reasons,
  ];

  return withEvent(
    decide(
      moderation.checked,
      moderation.flagged,
      safety.checked,
      safety.blocked,
      reasons,
      settings,
      options,
      {
        moderation: runModeration,
        safety: policy.jailbreakMode !== "OFF" || policy.offTopicMode !== "OFF",
      },
    ),
    subject,
  );
}

/**
 * Guard one chat turn: moderation sees the message AND its attachments (exactly
 * what the model would be given), while the LLM check reads the message text.
 *
 * Attachments are not re-sent to the classifier — they already went through
 * moderation, which reads images, and billing a vision model a second time per
 * turn is not worth what it would add.
 */
export async function guardChatTurn(
  message: string,
  modelContent: string | ModerationContentPart[],
  subject: GuardrailSubject,
  options: GuardOptions = {},
): Promise<GuardDecision> {
  const settings = options.settings ?? (await getGuardrailSettings());
  const policy = policyFor(settings, subject.surface);
  const runModeration = moderationEnabledFor(settings, subject.surface);

  const [moderation, safety] = await Promise.all([
    runModeration
      ? moderateContent(modelContent, subject)
      : Promise.resolve({ checked: false, flagged: false, categories: [] }),
    checkContentSafety(message, subject, {
      policy,
      topicDescription: settings.topicDescription,
    }),
  ]);

  const reasons = [
    ...moderation.categories.map((category) => `moderation:${category}`),
    ...safety.reasons,
  ];

  return withEvent(
    decide(
      moderation.checked,
      moderation.flagged,
      safety.checked,
      safety.blocked,
      reasons,
      settings,
      { ...options, requestPath: options.requestPath ?? true },
      {
        moderation: runModeration,
        safety: policy.jailbreakMode !== "OFF" || policy.offTopicMode !== "OFF",
      },
    ),
    subject,
  );
}

/**
 * Audit-only guard for content that has already reached the user or that a
 * teacher is waiting on: runs the same checks, logs whatever they find, and
 * never blocks. Fire-and-forget friendly.
 */
export async function auditText(
  text: string,
  subject: GuardrailSubject,
): Promise<GuardDecision> {
  const settings = await getGuardrailSettings();
  if (!moderationEnabledFor(settings, subject.surface)) {
    const policy = policyFor(settings, subject.surface);
    if (policy.jailbreakMode === "OFF" && policy.offTopicMode === "OFF")
      return ALLOWED;
  }
  const decision = await guardText(text, subject, {
    settings,
    requestPath: false,
  });
  // The event id survives: an audit finding is shown to a teacher as a warning
  // on work they are reviewing, and that warning is exactly the place a false
  // positive most needs a way to be argued with.
  return { ...decision, blocked: false, message: null };
}
