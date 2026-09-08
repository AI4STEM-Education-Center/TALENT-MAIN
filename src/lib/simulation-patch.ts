// Deterministic, AI-free edits to a generated simulation artifact: rename a
// piece of on-screen text, or edit / add / remove one of the LaTeX formulas in
// its model-relationships section.
//
// These are the changes a teacher can describe exactly, so routing them through
// the revision model would only add a two-minute wait and a chance of the model
// rewriting something else. Anything structural (new controls, different
// physics, a changed teaching direction) still belongs in the editing chat.
//
// Everything here is pure string work over the stored document, so it is fully
// unit-testable and the caller can re-run `validateSimulationHtml` on the result
// before publishing. Nothing is written unless that validation passes.

import {
  buildSimulationLatexMarker,
  checkSimulationLatex,
  escapeHtml,
  locateSimulationLatexMarkers,
  type SimulationLatexMatch,
} from "./simulation-math";

export type SimulationFormula = {
  /** Position among the valid markers — the id the preview and UI both use. */
  index: number;
  latex: string;
  display: "inline" | "block";
};

export type SimulationPatch =
  | { kind: "text"; before: string; after: string }
  | { kind: "formula-edit"; index: number; latex: string }
  | { kind: "formula-delete"; index: number }
  | { kind: "formula-add"; latex: string; display: "inline" | "block" };

/** Applied patch set, or the first reason the set could not be applied. */
export type PatchResult =
  { ok: true; html: string } | { ok: false; problem: string };

// ─── A very small HTML element scanner ────────────────────────────────────────
//
// Deleting a formula means deleting the card it lives in, which needs element
// boundaries. A full parser is overkill for a ≤120 KB self-contained document
// that our own generator prompt constrains, and a regex alone cannot find an
// enclosing element, so this walks the tag stream once and records ranges.

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is text, never markup — skipped wholesale. */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

/** Containers a formula card can be. Climbing stops at the first of these. */
const CARD_TAGS = new Set([
  "div",
  "li",
  "figure",
  "article",
  "section",
  "td",
  "p",
  "dd",
]);

const TOKEN_RE =
  /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

type ScannedElement = {
  tag: string;
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
};

type ScannedDocument = {
  elements: ScannedElement[];
  /**
   * `html` with every byte that is not rendered text replaced by NUL, so a
   * plain `indexOf` finds only real on-screen occurrences of a string.
   */
  textMask: string;
};

function scan(html: string): ScannedDocument {
  const elements: ScannedElement[] = [];
  const open: { tag: string; start: number; contentStart: number }[] = [];
  const mask = html.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) mask[i] = "\0";
  };
  const lower = html.toLowerCase();

  TOKEN_RE.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = TOKEN_RE.exec(html))) {
    const [raw, closing, rawTag, attributes] = token;
    const tokenEnd = token.index + raw.length;
    blank(token.index, tokenEnd);
    if (!rawTag) continue; // comment or doctype
    const tag = rawTag.toLowerCase();

    if (closing) {
      const depth = open.findLastIndex((entry) => entry.tag === tag);
      if (depth === -1) continue;
      // Anything still open above the match was never closed; end it here.
      for (let i = open.length - 1; i > depth; i -= 1) {
        elements.push({
          ...open[i],
          contentEnd: token.index,
          end: token.index,
        });
      }
      elements.push({ ...open[depth], contentEnd: token.index, end: tokenEnd });
      open.length = depth;
      continue;
    }

    if (VOID_TAGS.has(tag) || attributes.trimEnd().endsWith("/")) continue;

    if (RAW_TEXT_TAGS.has(tag)) {
      const closeStart = lower.indexOf(`</${tag}`, tokenEnd);
      const contentEnd = closeStart === -1 ? html.length : closeStart;
      const closeEnd =
        closeStart === -1
          ? html.length
          : html.indexOf(">", closeStart) + 1 || html.length;
      elements.push({
        tag,
        start: token.index,
        contentStart: tokenEnd,
        contentEnd,
        end: closeEnd,
      });
      blank(tokenEnd, closeEnd);
      TOKEN_RE.lastIndex = closeEnd;
      continue;
    }

    open.push({ tag, start: token.index, contentStart: tokenEnd });
  }

  for (const entry of open)
    elements.push({ ...entry, contentEnd: html.length, end: html.length });

  return { elements, textMask: mask.join("") };
}

/**
 * The range to remove when a formula is deleted: the innermost card-like
 * ancestor holding this formula and no other, or the marker alone when the
 * formula shares its container with its siblings.
 */
function cardRange(
  doc: ScannedDocument,
  marker: SimulationLatexMatch,
  all: SimulationLatexMatch[],
): { start: number; end: number } {
  const ancestors = doc.elements
    .filter(
      (el) => el.contentStart <= marker.start && el.contentEnd >= marker.end,
    )
    .sort((a, b) => a.end - a.start - (b.end - b.start));
  for (const el of ancestors) {
    if (!CARD_TAGS.has(el.tag)) continue;
    const holdsAnother = all.some(
      (other) =>
        other.start !== marker.start &&
        other.start >= el.contentStart &&
        other.end <= el.contentEnd,
    );
    return holdsAnother
      ? { start: marker.start, end: marker.end }
      : { start: el.start, end: el.end };
  }
  return { start: marker.start, end: marker.end };
}

/** The formulas a teacher can edit, in the order they appear on screen. */
export function listSimulationFormulas(html: string): SimulationFormula[] {
  return locateSimulationLatexMarkers(html).map((marker, index) => ({
    index,
    latex: marker.source,
    display: marker.display,
  }));
}

/** Where a text patch's `before` string sits in the document, if anywhere. */
function locateText(
  doc: ScannedDocument,
  before: string,
): { start: number; end: number } | string {
  for (const candidate of [before, escapeHtml(before)]) {
    const first = doc.textMask.indexOf(candidate);
    if (first === -1) continue;
    if (doc.textMask.indexOf(candidate, first + 1) !== -1)
      return `“${before}” appears more than once — describe that change in chat instead.`;
    return { start: first, end: first + candidate.length };
  }
  return `“${before}” is no longer in this version — it may be text the simulation's code writes at run time. Describe that change in chat instead.`;
}

type Edit = { start: number; end: number; text: string };

/**
 * Apply a set of edits to one stored artifact. Every patch is resolved against
 * the ORIGINAL document and spliced back to front, so a patch's offsets are
 * never invalidated by an earlier one in the same batch.
 */
export function applySimulationPatches(
  html: string,
  patches: SimulationPatch[],
): PatchResult {
  if (!patches.length) return { ok: false, problem: "Nothing to apply." };

  const doc = scan(html);
  const markers = locateSimulationLatexMarkers(html);
  const edits: Edit[] = [];
  const touchedFormulas = new Set<number>();
  let removals = 0;

  for (const patch of patches) {
    if (patch.kind === "text") {
      if (!patch.after.trim())
        return { ok: false, problem: "Replacement text cannot be empty." };
      const found = locateText(doc, patch.before);
      if (typeof found === "string") return { ok: false, problem: found };
      edits.push({ ...found, text: escapeHtml(patch.after) });
      continue;
    }

    if (patch.kind === "formula-add") {
      const reason = checkSimulationLatex(patch.latex, patch.display);
      if (reason) return { ok: false, problem: reason };
      const last = markers.at(-1);
      const replacement = buildSimulationLatexMarker({
        source: patch.latex.trim(),
        display: patch.display,
      });
      if (!last) {
        return {
          ok: false,
          problem:
            "This version has no formula section to add to. Ask for one in chat.",
        };
      }
      // Clone the last formula's card so the new one inherits its styling and
      // lands in the section a reader expects, rather than loose in the body.
      const card = cardRange(doc, last, markers);
      const clone =
        html.slice(card.start, last.start) +
        replacement +
        html.slice(last.end, card.end);
      edits.push({ start: card.end, end: card.end, text: clone });
      continue;
    }

    const marker = markers[patch.index];
    if (!marker)
      return {
        ok: false,
        problem: "That formula is no longer in this version.",
      };
    if (touchedFormulas.has(patch.index))
      return {
        ok: false,
        problem:
          "One formula has two pending changes — apply them one at a time.",
      };
    touchedFormulas.add(patch.index);

    if (patch.kind === "formula-edit") {
      const reason = checkSimulationLatex(patch.latex, marker.display);
      if (reason) return { ok: false, problem: reason };
      edits.push({
        start: marker.sourceStart,
        end: marker.sourceEnd,
        text: escapeHtml(patch.latex.trim()),
      });
      continue;
    }

    removals += 1;
    if (removals >= markers.length)
      return {
        ok: false,
        problem:
          "A simulation must keep at least one formula. Ask in chat to replace the formula section.",
      };
    edits.push({ ...cardRange(doc, marker, markers), text: "" });
  }

  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i += 1) {
    if (edits[i].start < edits[i - 1].end)
      return {
        ok: false,
        problem: "Two pending changes overlap — apply them one at a time.",
      };
  }

  let result = html;
  for (const edit of edits.slice().reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return { ok: true, html: result };
}

/** One-line description of a staged patch, for the editor list and the chat. */
export function describeSimulationPatch(
  patch: SimulationPatch,
  formulas: SimulationFormula[],
): string {
  switch (patch.kind) {
    case "text":
      return `Replace text ${JSON.stringify(patch.before)} with ${JSON.stringify(patch.after)}.`;
    case "formula-edit":
      return `Replace the formula ${JSON.stringify(formulas[patch.index]?.latex ?? "")} with ${JSON.stringify(patch.latex)}.`;
    case "formula-delete":
      return `Remove the formula ${JSON.stringify(formulas[patch.index]?.latex ?? "")}, along with any symbol definition it alone introduced.`;
    case "formula-add":
      return `Add a ${patch.display} formula ${JSON.stringify(patch.latex)} to the formula section, defining every new symbol and unit.`;
  }
}
