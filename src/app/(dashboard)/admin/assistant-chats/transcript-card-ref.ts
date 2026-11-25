import type { CoachActionRef } from "@/lib/assistant/coach-types";

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const optionalString = (value: unknown) =>
  value === undefined || isString(value);

/**
 * The stored interaction if it carries what the admin view prints; a malformed
 * one is dropped (the card still shows, without an outcome) rather than
 * trusted.
 */
function readInteraction(kind: CoachActionRef["kind"], raw: unknown) {
  if (!isObject(raw)) return undefined;
  switch (kind) {
    case "material":
    case "simulation":
      return raw;
    case "practice":
      return isString(raw.selectedText) && typeof raw.correct === "boolean"
        ? raw
        : undefined;
    case "diagnostic_options":
      return isString(raw.selectedLabel) ? raw : undefined;
  }
}

/** Whether `ref` has every field the admin transcript reads for its kind. */
function hasShape(ref: Loose): ref is Loose & { kind: CoachActionRef["kind"] } {
  if (!optionalString(ref.cardId)) return false;
  switch (ref.kind) {
    case "material":
      return (
        typeof ref.recommendationIndex === "number" &&
        Number.isFinite(ref.recommendationIndex) &&
        isString(ref.reason)
      );
    case "simulation":
      return (
        isString(ref.simulationId) &&
        isString(ref.goal) &&
        Array.isArray(ref.steps) &&
        ref.steps.every(isString) &&
        isString(ref.observe)
      );
    case "practice":
      return (
        isString(ref.versionId) &&
        isString(ref.variantQuestionId) &&
        isString(ref.reason) &&
        optionalString(ref.questionText)
      );
    case "diagnostic_options":
      return (
        isString(ref.prompt) &&
        Array.isArray(ref.options) &&
        ref.options.every(
          (option) =>
            isObject(option) && isString(option.id) && isString(option.label),
        )
      );
    default:
      return false;
  }
}

/**
 * A stored card ref, read defensively: transcripts are durable and may come
 * from older builds or the archive, so anything that doesn't look like a known
 * card — wrong kind, or missing/mistyped fields the viewer reads — is skipped
 * rather than trusted, and can never crash the transcript. Accepts both the
 * coach's plain refs and the study assistant's `{ source: "study", ref }`
 * wrapper.
 */
export function readCardRef(raw: unknown): CoachActionRef | null {
  if (!isObject(raw)) return null;
  const ref = raw.source === "study" && isObject(raw.ref) ? raw.ref : raw;
  if (!hasShape(ref)) return null;
  const interaction = readInteraction(ref.kind, ref.interaction);
  const card: Loose = { ...ref };
  if (interaction) card.interaction = interaction;
  else delete card.interaction;
  return card as unknown as CoachActionRef;
}
