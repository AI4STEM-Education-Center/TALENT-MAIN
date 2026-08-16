// Pure helpers for the per-question physics-simulation feature: the triage
// JSON schema + prompt (decide whether a simulation helps, pick the broad
// topic, write a build spec — or decline), the HTML-generation / one-pass
// revision / repair prompts, validation of the triage JSON, and the static safety
// validator for the generated HTML artifact. Everything here is pure (no DB /
// LLM / S3 / Prisma imports) so it can be unit-tested like `quiz-extraction.ts`;
// the impure engine that runs the calls lives in `simulation-engine.ts`.
//
// The feature's core privacy rule: simulations are shown to students POST-QUIZ
// while results are still blind, so the artifact must teach the question's
// broad topic without reproducing the question's numbers, scenario, options,
// or answer. That is enforced structurally: the HTML call never sees the raw
// question — only the triage-written spec, which is itself instructed to stay
// generic (a leakage firewall between the two calls).

import { Script } from "node:vm";
import { validateSimulationLatex } from "./simulation-math";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SimulationQuestionInput = {
  text: string;
  answerMode: string; // "SINGLE_SELECT" | "MULTI_SELECT" | "NUMERIC"
  options: { text: string }[]; // correctness deliberately not included
  figureAlt: string | null;
  quizName: string;
  topicName: string | null;
};

/** An already-generated READY sibling sim in the same quiz, for dedup. */
export type SiblingSimulation = { topic: string; title: string };

export type TriagePlan =
  | { helpful: false; refusalReason: string }
  | {
      helpful: true;
      /** 0-based index into the sibling list when an existing sim already covers this topic. */
      duplicateOfIndex: number | null;
      topic: string;
      title: string;
      learningGoal: string;
      spec: string;
    };

// ─── Limits / headers ─────────────────────────────────────────────────────────

/**
 * Hard cap on the generated HTML artifact. A simulation is intentionally a
 * small teaching aid, not a miniature application; keeping this tight also
 * makes truncated or needlessly elaborate model output fail validation.
 */
export const MAX_SIMULATION_HTML_BYTES = 120_000;

/**
 * CSP sent when serving a simulation artifact. Everything external is blocked
 * (the document must be self-contained); inline script/style is what the
 * artifact IS; data: URIs allow embedded images/fonts; only our own pages may
 * frame it. Rendered inside <iframe sandbox="allow-scripts"> (no
 * allow-same-origin), so the script also has no cookies, storage, or origin.
 */
export const SIMULATION_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; media-src data:; frame-ancestors 'self'";

// ─── Triage JSON schema (OpenAI structured output) ────────────────────────────

/**
 * Strict `response_format.json_schema` for the triage call, following the
 * repo conventions (snake_case wire format, every property required,
 * nullability via type arrays, `additionalProperties: false`).
 */
export const SIMULATION_TRIAGE_SCHEMA = {
  name: "simulation_triage",
  strict: true,
  schema: {
    type: "object",
    properties: {
      helpful: { type: "boolean" },
      refusal_reason: { type: ["string", "null"] },
      duplicate_of: { type: ["integer", "null"] },
      topic: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
      learning_goal: { type: ["string", "null"] },
      spec: { type: ["string", "null"] },
    },
    required: ["helpful", "refusal_reason", "duplicate_of", "topic", "title", "learning_goal", "spec"],
    additionalProperties: false,
  },
} as const;

// ─── Prompts ──────────────────────────────────────────────────────────────────

/**
 * Build the triage prompt. Pure + deterministic (asserted in tests). The model
 * sees the question (WITHOUT correctness data) plus the list of sibling sims
 * already generated for the same quiz, and must either decline, point at a
 * duplicate, or write a question-detail-free build spec.
 */
export function buildTriagePrompt(
  question: SimulationQuestionInput,
  siblings: SiblingSimulation[]
): string {
  const optionLines =
    question.options.length > 0
      ? question.options.map((o, i) => `  ${i + 1}. ${o.text}`).join("\n")
      : "  (free-response numeric question — no options)";
  const siblingBlock =
    siblings.length > 0
      ? siblings.map((s, i) => `  ${i + 1}. topic: ${s.topic} — title: ${s.title}`).join("\n")
      : "  (none yet)";

  return `You are planning an interactive physics/STEM simulation for a learning platform. Students see these simulations AFTER submitting a quiz, while their results are still hidden, as material to explore the topic they were tested on.

THE QUESTION (context only — the simulation must NOT be about this specific question):
Quiz: ${question.quizName}${question.topicName ? ` (topic group: ${question.topicName})` : ""}
Question text: ${question.text}
${question.figureAlt ? `Figure description: ${question.figureAlt}\n` : ""}Answer mode: ${question.answerMode}
Options:
${optionLines}

YOUR JOB — decide one of three outcomes:

1. DECLINE (helpful=false): decline when an interactive visual would not teach the concept better than a short explanation. Decline for recall/definition/terminology, conventions or notation, history-of-science facts, purely qualitative prompts, and topics with no meaningful adjustable model. A BUILD should expose one coherent system through 4 or 5 meaningful parameters and one visual. Give a short refusal_reason. When declining, every other field is null.

2. DUPLICATE (helpful=true, duplicate_of set): a simulation ALREADY generated for this quiz (listed below) teaches the same governing relationship, even if its title or real-world scenario differs. Prefer reuse over a near-duplicate. Set duplicate_of to that entry's number and every other field to null.
Existing simulations for this quiz:
${siblingBlock}

3. BUILD (helpful=true, duplicate_of=null): fill in topic, title, learning_goal, and spec. Model one coherent system; related quantities and derived relationships within that system belong together.

THE PRIVACY RULE (absolute): the simulation is shown while quiz results are blind, so it must never reveal anything about this specific question. The topic, title, learning_goal, and ESPECIALLY the spec must not contain the question's numbers, given values, named scenario, option values, or its answer. Zoom out to the general concept the question tests (e.g. a question about a 3 kg block on a 30° incline becomes "forces on an inclined plane" with fully student-adjustable mass and angle). Someone reading the spec must not be able to reconstruct the question or infer its answer.

THE SPEC: write a compact implementation brief of at most 200 words for a developer who will NOT see the question. It must name: (a) the coherent system to explore, (b) exactly 4 or 5 meaningful adjustable parameters with generic ranges/defaults, (c) one canvas or SVG visual, (d) 3–6 live readouts, (e) every governing and derived formula used by the model, up to 8 formulas, and (f) what changes when each control moves. A single graph may be drawn inside the main visual only when it directly clarifies the relationship. Request continuous animation only when motion over time is essential. Do not request tabs, menus, presets, multiple scenes, particle effects, challenges, scoring, or decorative features. Keep the interaction focused and dependable.

Use the exact JSON schema provided. Every property must be present (null where unused).`;
}

/**
 * Shared hard requirements for the artifact, embedded in both the build and
 * revision prompts so revised documents obey the same contract.
 */
const HTML_REQUIREMENTS = `PRIORITY: working interaction first, correct model second, clarity third, appearance last. Build the smallest page that fully teaches the learning goal.

HARD REQUIREMENTS for the document:
- ONE complete, self-contained HTML document. Start with <!doctype html> and end with </html>. No markdown fences, no commentary before or after.
- Everything inline: CSS in a <style> tag, JavaScript in <script> tags, plain JavaScript only (no external libraries, imports, or module loading).
- ZERO external references: no http(s):// or protocol-relative URLs in src/href/CSS url()/@import (an SVG xmlns attribute is fine), and no network APIs (fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon). The page runs in a sandboxed iframe with a CSP that blocks all of these — any external reference will simply break. Embedded images/fonts must be data: URIs.
- Forbidden elements: <iframe>, <object>, <embed>, <base>, <link>.
- Keep the complete document below 120 KB. Use one <style>, one visual stage (one <canvas> OR one root <svg>), and one non-module <script> placed at the end of <body>.

SIMPLE PRODUCT SHAPE:
- Compact header: one short <h1>, one-sentence description, and one-sentence instruction.
- Formula section: show EVERY governing, derived, and helper relationship actually used by the JavaScript calculations, up to 8 formulas. Define every symbol and unit. Never show a mathematical expression as plain text. Write each formula as raw LaTeX inside exactly <span class="sim-latex" data-display="block">LATEX_HERE</span> (or data-display="inline" inside prose). Do not include dollar-sign delimiters or HTML inside these markers. The server validates the LaTeX and renders it to MathML before display.
- Main area: the single visual plus a clear control panel. Provide exactly 4 or 5 meaningful adjustable parameters from the spec and 3–6 useful live readouts. Each control needs a visible label and current value with units.
- A single graph may be part of the main canvas/SVG when it materially explains the relationship. Do not add tabs, menus, accordions, presets, multiple modes/scenes, quizzes, challenges, scoring, particle systems, or decorative animation. Do not invent controls unrelated to the model.
- Use pause/resume and reset only when continuous time animation is genuinely needed. For a static relationship, redraw directly on input and omit the animation loop.

LAYOUT AND RELIABILITY:
- Desktop (width >= 700px): html/body are height:100%, margin:0, overflow:hidden. Use a three-row grid (compact header, formula panel, minmax(0,1fr) main area). Let the formula panel use a compact wrapping grid and internal overflow:auto when needed so every formula remains accessible instead of being clipped. The main area is visual-left/control-right and receives most of the space. Give shrinking grid/flex children min-width:0 and min-height:0.
- Phone (width < 700px): stack header, the complete formula panel, visual, then controls and allow vertical scrolling. Never allow horizontal scrolling or hide formulas.
- Size the visual from its actual container, not hard-coded stage dimensions. Redraw on resize. For canvas, account for devicePixelRatio without repeatedly scaling an already-scaled context.
- Put all DOM markup before the script. Give every parameter control a unique id and look each one up explicitly with document.getElementById(). Use one small state object and one named updateAndDraw() path that recalculates the model, updates every readout, and draws the visual. Every input listener calls that path. Call it once during startup.
- If animation is essential, keep exactly one requestAnimationFrame loop, clamp elapsed time after a background-tab pause, and prevent duplicate loops after pause/resume/reset.
- Use accurate math and units. Clamp invalid/zero denominators and non-finite values before drawing. Do not use eval or Function.
- Before returning, silently check: every referenced element ID exists exactly once; every control changes the state; every readout is updated; reset restores the displayed defaults; resize redraws; and the script has no undeclared or misspelled names.
- Do NOT reference any quiz, question, or answer anywhere in the page.`;

/**
 * Build the HTML-generation prompt from the triage plan ONLY (never the raw
 * question — the leakage firewall). Pure + deterministic.
 */
export function buildSimulationHtmlPrompt(plan: {
  topic: string;
  title: string;
  learningGoal: string;
  spec: string;
}): string {
  return `You are building a small interactive physics/STEM simulation as a single self-contained HTML page for a learning platform.

Topic: ${plan.topic}
Title: ${plan.title}
Learning goal: ${plan.learningGoal}

BUILD SPEC:
${plan.spec}

${HTML_REQUIREMENTS}

Return ONLY the HTML document.`;
}

/**
 * Build the revision prompt for one round of teacher feedback. The model gets
 * the plan, the CURRENT document, prior feedback (already applied), and the new
 * feedback to apply. Pure + deterministic.
 */
export function buildRevisionPrompt(
  plan: { topic: string; title: string; learningGoal: string; spec: string },
  currentHtml: string,
  priorFeedback: string[],
  newFeedback: string
): string {
  const prior =
    priorFeedback.length > 0
      ? priorFeedback.map((f, i) => `  ${i + 1}. ${f}`).join("\n")
      : "  (none)";
  return `You are revising an existing interactive simulation page for a learning platform. A teacher reviewed it and reported a problem to fix (a physics/math error, a layout issue, or a correction).

Topic: ${plan.topic}
Title: ${plan.title}
Learning goal: ${plan.learningGoal}

ORIGINAL BUILD SPEC:
${plan.spec}

FEEDBACK ALREADY APPLIED IN EARLIER REVISIONS (do not undo these):
${prior}

NEW FEEDBACK TO APPLY NOW:
${newFeedback}

CURRENT DOCUMENT:
${currentHtml}

Apply the new feedback with the smallest change that fully fixes it; keep everything else working as-is. The privacy rule still holds: never add anything about a specific quiz question or its answer.

COMPLETE THE REVISION IN ONE PASS. Before returning, silently inspect the finished document and correct every issue you find:
- Confirm the new feedback is genuinely and fully applied, and no earlier feedback was undone.
- Re-derive the governing physics/math; keep it correct, dimensionally consistent, in the right units, and identical to the displayed formulas.
- Preserve the required three-section layout on desktop and phone, including the non-scrolling height-filling desktop frame and responsive canvas.
- Trace the JavaScript end to end: animation, pause/resume, reset, every control, and every live readout must remain wired and free of obvious runtime errors.
Do not describe this inspection or return a checklist. Fix the document itself, then return only the finished HTML.

${HTML_REQUIREMENTS}

Return ONLY the complete revised HTML document.`;
}

/**
 * Build the one-shot repair prompt used when a generated document fails the
 * static validator. Pure + deterministic.
 */
export function buildRepairPrompt(problems: string[]): string {
  return `The document you returned failed validation:
${problems.map((p) => `- ${p}`).join("\n")}

Fix every problem. Simplify or rewrite the document when that is safer than patching it. Keep one visual, exactly 4 or 5 adjustable parameters, and render every formula through a valid sim-latex marker. Before returning, trace startup and each control event through the calculations, readouts, and draw call; correct any runtime or wiring mistake you find.

Return ONLY the complete corrected HTML document (starting with <!doctype html>, ending with </html>, no markdown fences).`;
}

// ─── Triage validation ────────────────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Structural validation of the raw triage JSON (snake_case) into a TriagePlan.
 * Throws descriptive Errors (qti.ts style) on shape problems. duplicate_of is
 * the model's 1-based index into the sibling list; anything out of range is
 * treated as "no duplicate" rather than failing the job.
 */
export function validateTriagePlan(input: unknown, siblingCount: number): TriagePlan {
  if (!isRecord(input)) throw new Error("triage: payload must be an object");
  if (typeof input.helpful !== "boolean") throw new Error("triage: helpful must be a boolean");

  if (!input.helpful) {
    return {
      helpful: false,
      refusalReason:
        nonEmptyString(input.refusal_reason) ?? "The model declined without giving a reason.",
    };
  }

  const rawDup = input.duplicate_of;
  if (typeof rawDup === "number" && Number.isInteger(rawDup) && rawDup >= 1 && rawDup <= siblingCount) {
    return {
      helpful: true,
      duplicateOfIndex: rawDup - 1,
      topic: nonEmptyString(input.topic) ?? "",
      title: nonEmptyString(input.title) ?? "",
      learningGoal: nonEmptyString(input.learning_goal) ?? "",
      spec: nonEmptyString(input.spec) ?? "",
    };
  }

  const topic = nonEmptyString(input.topic);
  const title = nonEmptyString(input.title);
  const learningGoal = nonEmptyString(input.learning_goal);
  const spec = nonEmptyString(input.spec);
  if (!topic) throw new Error("triage: topic is required when helpful and not a duplicate");
  if (!title) throw new Error("triage: title is required when helpful and not a duplicate");
  if (!learningGoal) throw new Error("triage: learning_goal is required when helpful and not a duplicate");
  if (!spec) throw new Error("triage: spec is required when helpful and not a duplicate");

  return { helpful: true, duplicateOfIndex: null, topic, title, learningGoal, spec };
}

// ─── HTML extraction + static validation ─────────────────────────────────────

/**
 * Extract the HTML document from a raw model response: strips surrounding
 * markdown fences / commentary by slicing from the first `<!doctype html` (or
 * `<html`) through the last `</html>`. Returns the trimmed raw text when no
 * document markers are found (the validator will then reject it with a
 * precise reason).
 */
export function extractHtmlDocument(raw: string): string {
  const text = raw.trim();
  const lower = text.toLowerCase();
  let start = lower.indexOf("<!doctype html");
  if (start === -1) start = lower.indexOf("<html");
  const endTag = lower.lastIndexOf("</html>");
  if (start === -1 || endTag === -1 || endTag < start) return text;
  return text.slice(start, endTag + "</html>".length).trim();
}

const FORBIDDEN_TAG_RE = /<\s*(iframe|object|embed|base|link)\b/i;
const EXTERNAL_ATTR_RE = /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i;
const EXTERNAL_CSS_URL_RE = /url\(\s*["']?\s*(?:https?:)?\/\//i;
const CSS_IMPORT_RE = /@import\b/i;
const NETWORK_API_RE = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/;
const VISUAL_STAGE_RE = /<\s*(canvas|svg)\b/gi;
const STYLE_TAG_RE = /<\s*style\b/gi;
const SCRIPT_BLOCK_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const PARAMETER_CONTROL_RE = /<\s*(input|select)\b([^>]*)>/gi;
const ID_ATTRIBUTE_RE = /<[a-z][^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>/gi;
const GET_ELEMENT_BY_ID_RE = /\bgetElementById\(\s*["']([^"']+)["']\s*\)/g;

function matches(text: string, pattern: RegExp): RegExpMatchArray[] {
  return Array.from(text.matchAll(pattern));
}

/** Find student-adjustable inputs, excluding action buttons and hidden fields. */
function parameterControls(html: string): RegExpMatchArray[] {
  return matches(html, PARAMETER_CONTROL_RE).filter((match) => {
    if (match[1].toLowerCase() === "select") return true;
    const type = match[2].match(/\btype\s*=\s*["']?([^\s"'>]+)/i)?.[1]?.toLowerCase() ?? "text";
    return !["button", "submit", "reset", "hidden"].includes(type);
  });
}

/**
 * Static safety/structure check for a generated simulation document. Returns a
 * list of human-readable problems (empty = valid). Belt-and-braces on top of
 * the serving CSP + iframe sandbox: it keeps obviously broken or
 * externally-dependent documents from ever being stored.
 */
export function validateSimulationHtml(html: string): string[] {
  const problems: string[] = [];
  const text = html.trim();
  const lower = text.toLowerCase();

  if (!text) return ["document is empty"];
  if (!lower.startsWith("<!doctype html") && !lower.startsWith("<html")) {
    problems.push("document must start with <!doctype html>");
  }
  if (!lower.endsWith("</html>")) {
    problems.push("document must end with </html>");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SIMULATION_HTML_BYTES) {
    problems.push(`document exceeds ${MAX_SIMULATION_HTML_BYTES} bytes`);
  }
  if (!lower.includes("<script")) {
    problems.push("document has no <script> — the simulation must be interactive");
  }

  const styles = matches(text, STYLE_TAG_RE);
  if (styles.length !== 1) {
    problems.push(`document must contain exactly one <style> tag (found ${styles.length})`);
  }

  const stages = matches(text, VISUAL_STAGE_RE);
  if (stages.length !== 1) {
    problems.push(`document must contain exactly one visual stage: one <canvas> or one <svg> (found ${stages.length})`);
  }

  const controls = parameterControls(text);
  if (controls.length < 4 || controls.length > 5) {
    problems.push(`document must contain exactly 4 or 5 adjustable parameter controls (found ${controls.length})`);
  }

  const scripts = matches(text, SCRIPT_BLOCK_RE);
  if (scripts.length !== 1) {
    problems.push(`document must contain exactly one inline <script> (found ${scripts.length})`);
  } else {
    const [attributes, source] = [scripts[0][1], scripts[0][2]];
    if (/\b(?:src|type\s*=\s*["']?module)\b/i.test(attributes)) {
      problems.push("document script must be inline and non-module");
    } else {
      try {
        new Script(source, { filename: "generated-simulation.js" });
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : "unknown syntax error";
        problems.push(`document JavaScript does not parse: ${message}`);
      }
    }
  }

  const ids = matches(text, ID_ATTRIBUTE_RE).map((match) => match[1]);
  const idCounts = new Map<string, number>();
  for (const id of ids) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  const duplicateIds: string[] = [];
  for (const [id, count] of idCounts) {
    if (count > 1) duplicateIds.push(id);
  }
  if (duplicateIds.length > 0) {
    problems.push(`document has duplicate element id(s): ${duplicateIds.join(", ")}`);
  }

  const referencedIds = new Set<string>();
  const missingIdSet = new Set<string>();
  for (const match of matches(text, GET_ELEMENT_BY_ID_RE)) {
    const id = match[1];
    referencedIds.add(id);
    if (!idCounts.has(id)) missingIdSet.add(id);
  }
  const missingIds = [...missingIdSet];
  if (missingIds.length > 0) {
    problems.push(`script references missing element id(s): ${missingIds.join(", ")}`);
  }

  const controlsWithoutIds: string[] = [];
  const unwiredControlIds: string[] = [];
  for (const control of controls) {
    const id = control[0].match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!id) controlsWithoutIds.push(control[1].toLowerCase());
    else if (!referencedIds.has(id)) unwiredControlIds.push(id);
  }
  if (controlsWithoutIds.length > 0) {
    problems.push(`every adjustable parameter control needs a unique id (missing on: ${controlsWithoutIds.join(", ")})`);
  }
  if (unwiredControlIds.length > 0) {
    problems.push(`script must look up every adjustable parameter control by id (missing: ${unwiredControlIds.join(", ")})`);
  }

  problems.push(...validateSimulationLatex(text));

  const tag = text.match(FORBIDDEN_TAG_RE);
  if (tag) problems.push(`forbidden element <${tag[1].toLowerCase()}>`);
  if (EXTERNAL_ATTR_RE.test(text)) {
    problems.push("src/href references an external URL — the document must be self-contained");
  }
  if (EXTERNAL_CSS_URL_RE.test(text)) {
    problems.push("CSS url() references an external URL — embed assets as data: URIs");
  }
  if (CSS_IMPORT_RE.test(text)) {
    problems.push("@import is not allowed — inline all CSS");
  }
  const api = text.match(NETWORK_API_RE);
  if (api) {
    problems.push(`network API ${api[0].replace(/\s*\($/, "")}() is not allowed — the page cannot make requests`);
  }
  return problems;
}
