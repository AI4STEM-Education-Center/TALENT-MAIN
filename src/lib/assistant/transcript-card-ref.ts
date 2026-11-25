import type {
  CoachActionRef,
  CoachDiagnosticInteraction,
  CoachMaterialInteraction,
  CoachPracticeInteraction,
  CoachSimulationInteraction,
} from "./coach-types";

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const optionalString = (value: unknown) =>
  value === undefined || isString(value);

function readMaterialInteraction(
  raw: unknown,
): CoachMaterialInteraction | undefined {
  if (!isObject(raw)) return undefined;
  return raw.status === "viewed" && isString(raw.viewedAt)
    ? {
        status: "viewed",
        viewedAt: raw.viewedAt,
        ...(isString(raw.summary) ? { summary: raw.summary } : {}),
      }
    : undefined;
}

function readSimulationInteraction(
  raw: unknown,
): CoachSimulationInteraction | undefined {
  if (!isObject(raw)) return undefined;
  return raw.status === "opened" &&
    isString(raw.openedAt) &&
    isString(raw.lastInteractedAt)
    ? {
        status: "opened",
        openedAt: raw.openedAt,
        lastInteractedAt: raw.lastInteractedAt,
        ...(isString(raw.summary) ? { summary: raw.summary } : {}),
      }
    : undefined;
}

function readPracticeInteraction(
  raw: unknown,
): CoachPracticeInteraction | undefined {
  if (!isObject(raw)) return undefined;
  return isString(raw.selectedText) && typeof raw.correct === "boolean"
    ? {
        status: "completed",
        selectedOptionId: isString(raw.selectedOptionId)
          ? raw.selectedOptionId
          : null,
        selectedText: raw.selectedText,
        numericValue:
          typeof raw.numericValue === "number" &&
          Number.isFinite(raw.numericValue)
            ? raw.numericValue
            : null,
        correct: raw.correct,
        completedAt: isString(raw.completedAt) ? raw.completedAt : "",
      }
    : undefined;
}

function readDiagnosticInteraction(
  raw: unknown,
): CoachDiagnosticInteraction | undefined {
  if (!isObject(raw)) return undefined;
  return isString(raw.selectedLabel)
    ? {
        status: "selected",
        ...(isString(raw.selectedOptionId)
          ? { selectedOptionId: raw.selectedOptionId }
          : {}),
        selectedLabel: raw.selectedLabel,
        selectedAt: isString(raw.selectedAt) ? raw.selectedAt : "",
      }
    : undefined;
}

/**
 * A stored card ref, read defensively with an explicit field allowlist:
 * transcripts are durable and may come from older builds or the archive, so
 * anything that doesn't look like a known card is skipped rather than trusted,
 * and extra/unknown properties are never forwarded. Accepts both the coach's
 * plain refs and the study assistant's `{ source: "study", ref }` wrapper.
 */
export function readCardRef(raw: unknown): CoachActionRef | null {
  if (!isObject(raw)) return null;
  const ref = raw.source === "study" && isObject(raw.ref) ? raw.ref : raw;
  if (!optionalString(ref.cardId)) return null;
  const cardId = isString(ref.cardId) ? ref.cardId : undefined;

  switch (ref.kind) {
    case "material": {
      if (
        typeof ref.recommendationIndex !== "number" ||
        !Number.isFinite(ref.recommendationIndex) ||
        !isString(ref.reason)
      )
        return null;
      const interaction = readMaterialInteraction(ref.interaction);
      return {
        kind: "material",
        ...(cardId ? { cardId } : {}),
        recommendationIndex: ref.recommendationIndex,
        reason: ref.reason,
        ...(interaction ? { interaction } : {}),
      };
    }
    case "simulation": {
      if (
        !isString(ref.simulationId) ||
        !isString(ref.goal) ||
        !Array.isArray(ref.steps) ||
        !ref.steps.every(isString) ||
        !isString(ref.observe)
      )
        return null;
      const interaction = readSimulationInteraction(ref.interaction);
      return {
        kind: "simulation",
        ...(cardId ? { cardId } : {}),
        simulationId: ref.simulationId,
        goal: ref.goal,
        steps: [...ref.steps],
        observe: ref.observe,
        ...(interaction ? { interaction } : {}),
      };
    }
    case "practice": {
      if (
        !isString(ref.versionId) ||
        !isString(ref.variantQuestionId) ||
        !isString(ref.reason) ||
        !optionalString(ref.questionText)
      )
        return null;
      const interaction = readPracticeInteraction(ref.interaction);
      return {
        kind: "practice",
        ...(cardId ? { cardId } : {}),
        versionId: ref.versionId,
        variantQuestionId: ref.variantQuestionId,
        reason: ref.reason,
        ...(isString(ref.questionText)
          ? { questionText: ref.questionText }
          : {}),
        ...(interaction ? { interaction } : {}),
      };
    }
    case "diagnostic_options": {
      if (
        !isString(ref.prompt) ||
        !Array.isArray(ref.options) ||
        !ref.options.every(
          (option) =>
            isObject(option) && isString(option.id) && isString(option.label),
        )
      )
        return null;
      const interaction = readDiagnosticInteraction(ref.interaction);
      return {
        kind: "diagnostic_options",
        ...(cardId ? { cardId } : {}),
        prompt: ref.prompt,
        options: ref.options.map((option) => ({
          id: option.id as string,
          label: option.label as string,
        })),
        ...(interaction ? { interaction } : {}),
      };
    }
    default:
      return null;
  }
}
