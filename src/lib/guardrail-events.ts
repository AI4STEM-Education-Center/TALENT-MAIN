// Guardrail findings a user was actually shown, and the feedback they send back
// about them.
//
// The user-facing message a guardrail produces is deliberately vague — it never
// names the check that fired, because saying so is a free hint to anyone probing
// the thing. That vagueness is right for the message and terrible for the
// person on the other end of a FALSE positive, who is left with no way to say
// "this was a legitimate question". These rows close that loop: the notice
// carries an event id, the user attaches a sentence to it, and an admin reads
// the sentence next to the reasons the user was never shown.
//
// Recording NEVER throws. A guardrail layer that can take a request down when
// its bookkeeping table is unhappy is worse than the content it was built to
// catch, which is the same posture the checks themselves take.

import { prisma } from "@/lib/prisma";
import { logSystemEvent } from "@/lib/system-log";

/** Longest report accepted. Long enough for context, short enough to read. */
export const MAX_FEEDBACK_CHARS = 2_000;

export const GUARDRAIL_FEEDBACK_STATUSES = [
  "NEW",
  "REVIEWED",
  "DISMISSED",
] as const;
export type GuardrailFeedbackStatus =
  (typeof GUARDRAIL_FEEDBACK_STATUSES)[number];

export function isGuardrailFeedbackStatus(
  value: unknown,
): value is GuardrailFeedbackStatus {
  return (
    typeof value === "string" &&
    (GUARDRAIL_FEEDBACK_STATUSES as readonly string[]).includes(value)
  );
}

export interface GuardrailEventInput {
  surface: string;
  subjectId?: string | null;
  userId?: string | null;
  /** True when the submission was refused, false for a warning they can read. */
  blocked: boolean;
  /** Trip descriptions. Admin-only — never rendered to the user. */
  reasons: string[];
}

/**
 * Record a finding a user was shown and return its id, or null if it could not
 * be written.
 *
 * A null id costs the user their "report a problem" button on that one notice
 * and costs the request nothing else, which is the right trade: the block
 * itself already happened and is already in the audit log.
 */
export async function recordGuardrailEvent(
  input: GuardrailEventInput,
): Promise<string | null> {
  try {
    const event = await prisma.guardrailEvent.create({
      data: {
        surface: input.surface,
        subjectId: input.subjectId ?? null,
        userId: input.userId ?? null,
        blocked: input.blocked,
        reasons: JSON.stringify(input.reasons ?? []),
      },
      select: { id: true },
    });
    return event.id;
  } catch (error) {
    void logSystemEvent({
      category: "GUARDRAIL",
      type: "EVENT_RECORD_FAILED",
      severity: "INFO",
      message: `Could not record a guardrail event on ${input.surface}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      userId: input.userId ?? null,
      metadata: { surface: input.surface, subjectId: input.subjectId ?? null },
    });
    return null;
  }
}

export type FeedbackResult = "saved" | "not_found" | "empty";

/**
 * Attach a user's report to one event.
 *
 * The event must belong to the reporting user. Anything else — an unknown id, a
 * guessed one, another user's — is reported as `not_found` rather than
 * "forbidden", so the endpoint cannot be used to discover which ids exist or
 * how often the guardrails fire for other people.
 *
 * Resubmitting EDITS the existing report rather than stacking a second one, and
 * moves it back to NEW so an edit after a review is seen again.
 */
export async function submitGuardrailFeedback(
  eventId: string,
  userId: string,
  message: string,
): Promise<FeedbackResult> {
  const trimmed = message.trim().slice(0, MAX_FEEDBACK_CHARS);
  if (!trimmed) return "empty";

  const event = await prisma.guardrailEvent.findFirst({
    where: { id: eventId, userId },
    select: { id: true },
  });
  if (!event) return "not_found";

  await prisma.guardrailFeedback.upsert({
    where: { eventId },
    update: {
      message: trimmed,
      status: "NEW",
      reviewedAt: null,
      reviewedBy: null,
    },
    create: { eventId, userId, message: trimmed },
  });

  void logSystemEvent({
    category: "GUARDRAIL",
    type: "FEEDBACK_SUBMITTED",
    severity: "INFO",
    message: `A user reported a guardrail result as wrong (event ${eventId}).`,
    userId,
    metadata: { eventId },
  });

  return "saved";
}

/** Parse the stored reasons array, tolerating anything unreadable. */
export function readReasons(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    return [];
  }
}
