// Pure helpers for the per-question physics-simulation feature: the triage
// JSON schema + prompt (decide whether a simulation helps, pick the broad
// topic, write a build spec — or decline), the HTML-generation / revision /
// repair prompts, validation of the triage JSON, and the static safety
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

/** Hard cap on the generated HTML artifact (bytes of UTF-8 text, ~400 KB). */
export const MAX_SIMULATION_HTML_BYTES = 400_000;

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

1. DECLINE (helpful=false): an interactive simulation would not aid understanding. Decline for pure recall/definition/terminology questions, questions about conventions or notation, history-of-science facts, or anything with no dynamic quantitative relationship to explore. Give a short refusal_reason. When declining, every other field is null.

2. DUPLICATE (helpful=true, duplicate_of set): a simulation ALREADY generated for this quiz (listed below) covers the same broad topic this question tests. Set duplicate_of to that entry's number and every other field to null — do not write a new spec for a topic that already has one.
Existing simulations for this quiz:
${siblingBlock}

3. BUILD (helpful=true, duplicate_of=null): fill in topic, title, learning_goal, and spec.

THE PRIVACY RULE (absolute): the simulation is shown while quiz results are blind, so it must never reveal anything about this specific question. The topic, title, learning_goal, and ESPECIALLY the spec must not contain the question's numbers, given values, named scenario, option values, or its answer. Zoom out to the general concept the question tests (e.g. a question about a 3 kg block on a 30° incline becomes "forces on an inclined plane" with fully student-adjustable mass and angle). Someone reading the spec must not be able to reconstruct the question or infer its answer.

THE SPEC: a self-contained build brief (a few hundred words) for a developer who will NOT see the question. Describe: the physical system and the quantitative relationship to make explorable; which parameters the student can adjust (with sensible generic ranges and defaults — never the question's values); what is animated/plotted and how it responds; which formulas govern the model; readouts to display; and the layout (canvas area + controls). Target a simple, single-screen, canvas-based interactive that runs at 60fps with plain JavaScript — no external libraries.

Use the exact JSON schema provided. Every property must be present (null where unused).`;
}

/**
 * Shared hard requirements for the artifact, embedded in both the build and
 * revision prompts so revised documents obey the same contract.
 */
const HTML_REQUIREMENTS = `HARD REQUIREMENTS for the document:
- ONE complete, self-contained HTML document. Start with <!doctype html> and end with </html>. No markdown fences, no commentary before or after.
- Everything inline: CSS in a <style> tag, JavaScript in <script> tags, plain JavaScript only (no external libraries, imports, or module loading).
- ZERO external references: no http(s):// or protocol-relative URLs in src/href/CSS url()/@import (an SVG xmlns attribute is fine), and no network APIs (fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon). The page runs in a sandboxed iframe with a CSP that blocks all of these — any external reference will simply break. Embedded images/fonts must be data: URIs.
- Forbidden elements: <iframe>, <object>, <embed>, <base>, <link>.
- Render the simulation on a <canvas> (or inline SVG), animated with requestAnimationFrame, with a pause/resume and a reset control.
- Controls: sliders/buttons with visible labels and current values; the simulation responds immediately when they change.
- Responsive: fill the viewport width, work from ~360px phones up to desktop, and keep controls usable with touch. No horizontal page scrolling.
- Self-explanatory: a short title and one or two sentences telling the student what to try and what to notice. Show live numeric readouts of the governing quantities, and the key formula(s) where they help.
- Use accurate physics with correct units. Prefer simple and correct over flashy.
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

Fix every problem and return ONLY the complete corrected HTML document (starting with <!doctype html>, ending with </html>, no markdown fences).`;
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
