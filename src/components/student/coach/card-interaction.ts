// Client helpers for recording what a student did with an assistant card
// (opened a material, explored a simulation, picked a diagnostic option,
// answered a practice question). The server stores the interaction on the
// card's ref inside the transcript, so reopening a conversation — or the coach
// reading it on the next turn — sees the same state the student saw.

import type {
  AssistantCardInteractionInput,
  AssistantCardInteractionResult,
  CoachActionView,
  CoachPracticeInteraction,
} from "@/lib/assistant/coach-types";
import type { CoachTarget } from "./use-coach-chat";

export type CardInteraction =
  AssistantCardInteractionResult["interaction"] | CoachPracticeInteraction;

/** The kind-specific part of an interaction; the scope is added on save. */
export type CardInteractionInput = AssistantCardInteractionInput extends infer T
  ? T extends unknown
    ? Omit<T, "conversationId" | "attemptId" | "questionNumber">
    : never
  : never;

/** Where a card's interaction is filed: its conversation, or its question. */
export type CardScope = {
  conversationId?: string | null;
  target?: CoachTarget;
};

/** Which surface a card list is rendered on; picks the telemetry labels. */
export type CardSource = "coach" | "widget";

export function scopeFields(
  scope: CardScope,
): Pick<
  AssistantCardInteractionInput,
  "conversationId" | "attemptId" | "questionNumber"
> | null {
  if (scope.conversationId) return { conversationId: scope.conversationId };
  if (scope.target)
    return {
      attemptId: scope.target.attemptId,
      questionNumber: scope.target.questionNumber,
    };
  return null;
}

/**
 * POST the interaction. Best effort: returns the server's saved copy, or null
 * when it was not recorded (the caller decides whether to roll back). Cards
 * without a `cardId` (older transcripts) are still sent: the server matches
 * them by simulation, material/recommendation index, or option instead.
 */
export async function saveCardInteraction(
  scope: CardScope,
  input: CardInteractionInput,
): Promise<CardInteraction | null> {
  const fields = scopeFields(scope);
  if (!fields) return null;
  try {
    const res = await fetch("/api/assistant/card-interaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fields, ...input }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as AssistantCardInteractionResult;
    return data.interaction ?? null;
  } catch {
    return null;
  }
}

/** Bubbles with `interaction` set on the card carrying `cardId`. */
export function withCardInteraction<T extends { cards?: CoachActionView[] }>(
  bubbles: T[],
  cardId: string,
  interaction: CardInteraction,
): T[] {
  let changed = false;
  const next = bubbles.map((bubble) => {
    if (!bubble.cards?.some((card) => card.cardId === cardId)) return bubble;
    changed = true;
    return {
      ...bubble,
      cards: bubble.cards.map((card) =>
        card.cardId === cardId
          ? ({ ...card, interaction } as CoachActionView)
          : card,
      ),
    };
  });
  return changed ? next : bubbles;
}
