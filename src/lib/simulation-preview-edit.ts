/**
 * The message contract between the in-preview editing layer and the app.
 *
 * Everything inside the sandbox is AI-generated document plus teacher typing,
 * so nothing crossing this boundary is trusted: the shapes below are the only
 * ones that reach the staging list, and every string is length-capped to the
 * same limits the edit route enforces.
 */
const MAX_TEXT = 2000;
const MAX_LATEX = 500;
type Display = "inline" | "block";

/**
 * One committed edit from the in-preview layer. `token` identifies what was
 * edited so re-editing it replaces its staged patch, and `before` is always the
 * ORIGINAL wording rather than the previous edit's result.
 */
export type SimulationPreviewChange =
  | { kind: "text"; token: string; before: string; after: string }
  | { kind: "text-revert"; token: string }
  | {
      kind: "formula-edit";
      token: string;
      index: number;
      latex: string;
      display: Display;
    }
  | {
      kind: "formula-add";
      token: string;
      anchor: number;
      latex: string;
      display: Display;
    }
  | { kind: "formula-delete"; token: string; index: number }
  | { kind: "formula-drop"; token: string };

export type SimulationPreviewEdit = SimulationPreviewChange & {
  /** Paint a rendered formula back over the LaTeX the teacher just typed. */
  paint: (html: string | null, latex: string) => void;
};

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}
function index(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}
function display(value: unknown): Display {
  return value === "inline" ? "inline" : "block";
}

/**
 * Validate a message from the sandboxed document. Everything in there is
 * AI-generated and teacher-typed, so nothing is trusted on the way out: the
 * shapes below are the only ones that reach the staging list.
 */
export function readPreviewEdit(data: unknown): SimulationPreviewChange | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  const token = text(message.token, 120);
  if (!token) return null;
  switch (message.type) {
    case "simulation-text-edit": {
      const before = text(message.before, MAX_TEXT);
      const after = text(message.after, MAX_TEXT);
      return before && after ? { kind: "text", token, before, after } : null;
    }
    case "simulation-text-revert":
      return { kind: "text-revert", token };
    case "simulation-formula-edit": {
      const at = index(message.index);
      const latex = text(message.latex, MAX_LATEX);
      return at !== null && latex
        ? {
            kind: "formula-edit",
            token,
            index: at,
            latex,
            display: display(message.display),
          }
        : null;
    }
    case "simulation-formula-add": {
      const anchor = index(message.after);
      const latex = text(message.latex, MAX_LATEX);
      return anchor !== null && latex
        ? {
            kind: "formula-add",
            token,
            anchor,
            latex,
            display: display(message.display),
          }
        : null;
    }
    case "simulation-formula-delete": {
      const at = index(message.index);
      return at === null ? null : { kind: "formula-delete", token, index: at };
    }
    case "simulation-formula-drop":
      return { kind: "formula-drop", token };
    default:
      return null;
  }
}
