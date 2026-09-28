// Pure half of the research-survey feature: the question shape, the one
// normalizer every write goes through (AI extraction, the heuristic PDF-text
// parser, and admin edits alike), answer validation, and the AI schema and
// prompt. No Prisma / SDK imports, so the admin editor, the survey renderer,
// the worker and the unit tests all share it.

export const SURVEY_KINDS = ["PRE", "POST"] as const;
export type SurveyKind = (typeof SURVEY_KINDS)[number];

export const SURVEY_ROLES = ["STUDENT", "TEACHER"] as const;
export type SurveyRole = (typeof SURVEY_ROLES)[number];

export const SURVEY_KIND_LABELS: Record<SurveyKind, string> = {
  PRE: "Pre-survey",
  POST: "Post-survey",
};

export const SURVEY_ROLE_LABELS: Record<SurveyRole, string> = {
  STUDENT: "Student",
  TEACHER: "Teacher",
};

export function isSurveyKind(value: unknown): value is SurveyKind {
  return (
    typeof value === "string" &&
    (SURVEY_KINDS as readonly string[]).includes(value)
  );
}

export function isSurveyRole(value: unknown): value is SurveyRole {
  return (
    typeof value === "string" &&
    (SURVEY_ROLES as readonly string[]).includes(value)
  );
}

/**
 * "section" is a heading/instructions block with no answer. "likert" and
 * "single" are one choice from the options (likert renders as a horizontal
 * scale), "multi" is any number of them, "text"/"textarea" are free text.
 */
export const SURVEY_QUESTION_TYPES = [
  "section",
  "likert",
  "single",
  "multi",
  "text",
  "textarea",
] as const;
export type SurveyQuestionType = (typeof SURVEY_QUESTION_TYPES)[number];

export const SURVEY_QUESTION_TYPE_LABELS: Record<SurveyQuestionType, string> = {
  section: "Section heading",
  likert: "Rating scale",
  single: "Single choice",
  multi: "Multiple choice (select all)",
  text: "Short answer",
  textarea: "Long answer",
};

export type SurveyQuestion = {
  id: string;
  type: SurveyQuestionType;
  text: string;
  /** Instructions under the prompt; for a section, its body text. */
  help: string;
  options: string[];
  /**
   * For single/multi choice: label of an extra option that reveals a free-text
   * box ("Other", "Prefer to self-describe"). Empty when there is none. The
   * stored answer is "<label>: <typed text>".
   */
  otherLabel: string;
  required: boolean;
};

export type SurveyAnswers = Record<string, string | string[]>;

export const DEFAULT_LIKERT_SCALE = [
  "Strongly disagree",
  "Disagree",
  "Neutral",
  "Agree",
  "Strongly agree",
];

export const MAX_SURVEY_QUESTIONS = 200;
export const MAX_QUESTION_TEXT = 2000;
export const MAX_OPTION_TEXT = 300;
export const MAX_OPTIONS = 20;
export const MAX_TEXT_ANSWER = 5000;
export const MAX_SOURCE_TEXT = 100_000;

/**
 * Wording for the interview-contact block that closes every pre-survey. It
 * deliberately says nothing about compensation — only that the contact is for
 * research purposes, to improve the platform.
 */
export const INTERVIEW_CONTACT_COPY = {
  heading: "Follow-up interview",
  body: "Would you be willing to be contacted by email about a possible follow-up interview? This is for research purposes only, to help us improve the platform. Agreeing only lets the research team reach out — you can still decline later.",
  checkbox:
    "Yes, the research team may contact me by email about an interview.",
  emailLabel: "Email address we may contact",
} as const;

function isQuestionType(value: unknown): value is SurveyQuestionType {
  return (
    typeof value === "string" &&
    (SURVEY_QUESTION_TYPES as readonly string[]).includes(value)
  );
}

export function questionTakesOptions(type: SurveyQuestionType): boolean {
  return type === "likert" || type === "single" || type === "multi";
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function slugId(index: number): string {
  return `q${index + 1}`;
}

/**
 * Coerce anything (model output, a parsed PDF, an admin's edit) into a clean
 * question list: known types only, capped lengths, choice questions with at
 * least two distinct options, and unique stable ids. A choice question left
 * without enough options degrades to a short answer rather than being dropped,
 * so no prompt silently disappears.
 */
export function normalizeSurveyQuestions(input: unknown): SurveyQuestion[] {
  if (!Array.isArray(input)) return [];
  const used = new Set<string>();
  const out: SurveyQuestion[] = [];

  for (const raw of input.slice(0, MAX_SURVEY_QUESTIONS)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    let type: SurveyQuestionType = isQuestionType(r.type) ? r.type : "text";
    const text = cleanText(r.text, MAX_QUESTION_TEXT);
    const help = cleanText(r.help, MAX_QUESTION_TEXT);
    if (!text && !(type === "section" && help)) continue;

    let options: string[] = [];
    let otherLabel = "";
    if (questionTakesOptions(type)) {
      const seen = new Set<string>();
      for (const opt of Array.isArray(r.options) ? r.options : []) {
        const o = cleanText(opt, MAX_OPTION_TEXT);
        if (o && !seen.has(o.toLowerCase())) {
          seen.add(o.toLowerCase());
          options.push(o);
        }
        if (options.length >= MAX_OPTIONS) break;
      }
      if (type !== "likert") {
        otherLabel = cleanText(r.otherLabel, MAX_OPTION_TEXT);
        options = options.filter(
          (o) => o.toLowerCase() !== otherLabel.toLowerCase(),
        );
      }
      if (options.length + (otherLabel ? 1 : 0) < 2) {
        type = "text";
        options = [];
        otherLabel = "";
      }
    }

    let id =
      typeof r.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(r.id)
        ? r.id
        : "";
    if (!id || used.has(id)) {
      let n = out.length;
      do id = slugId(n++);
      while (used.has(id));
    }
    used.add(id);

    out.push({
      id,
      type,
      text,
      help,
      options,
      otherLabel,
      required: type === "section" ? false : r.required !== false,
    });
  }
  return out;
}

export function parseSurveyQuestions(
  json: string | null | undefined,
): SurveyQuestion[] {
  if (!json) return [];
  try {
    return normalizeSurveyQuestions(JSON.parse(json));
  } catch {
    return [];
  }
}

/** Whether a submitted choice is the question's "Other" option (with or without text). */
export function isOtherAnswer(q: SurveyQuestion, value: string): boolean {
  return (
    !!q.otherLabel &&
    (value === q.otherLabel || value.startsWith(`${q.otherLabel}: `))
  );
}

function acceptChoice(q: SurveyQuestion, value: string): string | null {
  if (q.options.includes(value)) return value;
  if (isOtherAnswer(q, value)) return value.slice(0, MAX_OPTION_TEXT + 500);
  return null;
}

export type AnswerValidation =
  | { ok: true; answers: SurveyAnswers }
  | { ok: false; error: string; questionId?: string };

/**
 * Check a submission against the form: required questions answered, choices
 * drawn from the question's own options, text capped. Unknown keys are
 * dropped, so the stored answers only ever reference real questions.
 */
export function validateSurveyAnswers(
  questions: readonly SurveyQuestion[],
  raw: unknown,
): AnswerValidation {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const answers: SurveyAnswers = {};

  for (const q of questions) {
    if (q.type === "section") continue;
    const value = input[q.id];
    const label = q.text.length > 80 ? `${q.text.slice(0, 77)}…` : q.text;

    if (q.type === "multi") {
      const picked = (Array.isArray(value) ? value : [])
        .filter((v): v is string => typeof v === "string")
        .map((v) => acceptChoice(q, v.trim()))
        .filter((v): v is string => v !== null);
      const unique = [...new Set(picked)];
      if (unique.length === 0) {
        if (q.required)
          return {
            ok: false,
            error: `Please answer: ${label}`,
            questionId: q.id,
          };
        continue;
      }
      answers[q.id] = unique;
      continue;
    }

    const text = typeof value === "string" ? value.trim() : "";
    if (!text) {
      if (q.required)
        return {
          ok: false,
          error: `Please answer: ${label}`,
          questionId: q.id,
        };
      continue;
    }
    if (questionTakesOptions(q.type)) {
      const accepted = acceptChoice(q, text);
      if (accepted === null)
        return {
          ok: false,
          error: `Choose one of the listed options for: ${label}`,
          questionId: q.id,
        };
      answers[q.id] = accepted;
    } else {
      answers[q.id] = text.slice(0, MAX_TEXT_ANSWER);
    }
  }
  return { ok: true, answers };
}

export function formatAnswer(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join("; ") : value;
}

// ─── Heuristic PDF-text parser ───────────────────────────────────────────────
// Used when no AI provider is assigned (and as the instant first draft while
// the AI pass runs). It only has to be good enough for the admin to fix up in
// the editor: numbered prompts become questions, lettered/bulleted lines under
// them become options, and a recognized agreement scale makes a rating scale.

const QUESTION_LINE = /^\s*(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[.):]\s*(.+)$/i;
const BOX = "○◯□☐■●•▪◻⬜❏";
const OPTION_LINE = new RegExp(
  `^\\s*(?:[a-hA-H][.)]|\\(\\s*[a-hA-H]?\\s*\\)|[${BOX}*-]|\\[\\s*\\])\\s*(.+)$`,
);
const BOX_SPLIT = new RegExp(`\\s*[${BOX}]\\s*`);
/** A Likert grid row: the statement followed by (at least three) bare boxes. */
const GRID_ROW = new RegExp(`^(.*?)\\s*(?:[${BOX}]\\s*){3,}[-–]?\\s*$`);
const BLANK_LINE = /^[_\s]{5,}$/;
const OTHER_OPTION =
  /^\s*(other|prefer to self-describe)\b[^_]*?:?\s*_{2,}\s*$/i;
const SECTION_LINE =
  /^\s*(?:(?:[Ss]ection|[Pp]art|SECTION|PART)\s+[A-Z0-9IVX]+\b.*|[A-Z][A-Z0-9 ,&/'()-]{5,80})$/;
const SCALE_WORDS =
  /strongly|disagree|agree|neutral|never|rarely|sometimes|often|always|very|not at all|somewhat|extremely|poor|fair|good|excellent/i;
/** Free-text prompts: questions, and imperatives asking for an explanation. */
function isOpenEnded(text: string): boolean {
  return (
    /\?\s*$/.test(text) ||
    /^(describe|explain|list|please|share|tell|give)\b/i.test(text) ||
    /\b(comments?|suggestions?)\s*:?\s*$/i.test(text)
  );
}

/**
 * A short Title Case line with no closing punctuation reads as a heading
 * ("Feasibility", "Prior Experience with Similar Learning Tools"), not as the
 * wrapped tail of a prompt or option.
 */
function looksLikeHeading(line: string): boolean {
  if (/[.?:,;]$/.test(line) || !/^[A-Z(]/.test(line)) return false;
  const words = line.split(" ").filter((w) => /[A-Za-z]/.test(w));
  if (words.length === 0 || words.length > 10) return false;
  const capped = words.filter((w) => /^[(]?[A-Z0-9]/.test(w)).length;
  return capped / words.length >= 0.6;
}

/** Re-join a parenthetical the PDF wrapped across lines ("(… 5-Strongly" + "Agree)"). */
function joinWrappedParens(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      (prev.match(/\(/g)?.length ?? 0) > (prev.match(/\)/g)?.length ?? 0)
    ) {
      out[out.length - 1] = `${prev} ${line}`;
    } else {
      out.push(line);
    }
  }
  return out;
}
const NUMERIC_SCALE =
  /(\d)\s*[=–-]\s*([A-Za-z][A-Za-z' ]{1,40}?)(?=\s*(?:,|;|\)|\d\s*[=–-]|$))/g;
const NUMERIC_SCALE_PAREN = /\s*\((?:[^()]*?scale:)?\s*1\s*[=–-][^()]*\)\s*/i;

/** "1 = Strongly disagree, 2 = Disagree … 5 = Strongly agree" → labels. */
export function parseNumericScale(line: string): string[] | null {
  const labels: Array<[number, string]> = [];
  for (const m of line.matchAll(NUMERIC_SCALE)) {
    labels.push([Number(m[1]), m[2].trim()]);
  }
  if (labels.length < 3) return null;
  labels.sort((a, b) => a[0] - b[0]);
  return labels.map(([n, label]) => `${n} - ${label}`);
}

/** "strongly disagree … strongly agree" header over a grid of boxes. */
function gridScale(line: string): string[] | null {
  const m = /^(.*?)\s*strongly\s+disagree\s+strongly\s+agree\s*$/i.exec(line);
  if (!m) return null;
  return ["1 - Strongly disagree", "2", "3", "4", "5 - Strongly agree"];
}

function looksLikeScale(options: string[]): boolean {
  return (
    options.length >= 3 &&
    options.filter((o) => SCALE_WORDS.test(o)).length >= options.length - 1
  );
}

export type ParsedSurvey = {
  title: string;
  description: string;
  questions: SurveyQuestion[];
};

export function parseSurveyText(text: string): ParsedSurvey {
  const lines = joinWrappedParens(
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );

  const drafts: Array<{
    type: SurveyQuestionType;
    text: string;
    help: string;
    options: string[];
  }> = [];
  let title = "";
  const intro: string[] = [];
  let current: (typeof drafts)[number] | null = null;
  let scale: string[] | null = null;
  const otherLabels = new Map<object, string>();

  const finish = () => {
    if (!current) return;
    if (current.type !== "section") {
      if (current.options.length + (otherLabels.has(current) ? 1 : 0) >= 2) {
        current.type = looksLikeScale(current.options) ? "likert" : "single";
        if (/select all|check all|all that apply/i.test(current.text))
          current.type = "multi";
      } else if (scale && !isOpenEnded(current.text)) {
        current.type = "likert";
        current.options = [...scale];
      } else {
        current.type = isOpenEnded(current.text) ? "textarea" : "text";
      }
    }
    drafts.push(current);
    current = null;
  };

  for (const line of lines) {
    if (BLANK_LINE.test(line)) continue;

    // A scale named inside a numbered prompt belongs to that prompt only.
    const q = QUESTION_LINE.exec(line);
    const numericScale = parseNumericScale(line);
    if (numericScale && !q) {
      if (
        current &&
        current.type !== "section" &&
        current.options.length === 0
      ) {
        // The prompt wrapped onto this line: its scale is its own.
        const rest = line.replace(NUMERIC_SCALE_PAREN, " ").trim();
        if (rest && !parseNumericScale(rest))
          current.text = `${current.text} ${rest}`;
        current.type = "likert";
        current.options = numericScale;
        drafts.push(current);
        current = null;
      } else {
        scale = numericScale;
      }
      continue;
    }

    if (q) {
      finish();
      let promptText = q[2];
      const own = numericScale
        ? { type: "likert" as const, options: numericScale }
        : null;
      if (own) promptText = promptText.replace(NUMERIC_SCALE_PAREN, " ").trim();
      current = {
        type: own ? "likert" : "text",
        text: promptText,
        help: "",
        options: own ? [...own.options] : [],
      };
      if (own) {
        drafts.push(current);
        current = null;
      }
      continue;
    }

    const header = gridScale(line);
    if (header) {
      finish();
      scale = header;
      const heading = header && line.replace(/strongly.*$/i, "").trim();
      if (heading)
        drafts.push({ type: "section", text: heading, help: "", options: [] });
      continue;
    }

    const grid = GRID_ROW.exec(line);
    if (grid && scale) {
      const statement = grid[1].trim();
      if (statement) {
        finish();
        drafts.push({
          type: "likert",
          text: statement,
          help: "",
          options: [...scale],
        });
      }
      continue;
    }

    if (current && current.type !== "section" && OTHER_OPTION.test(line)) {
      otherLabels.set(current, line.replace(/[:_\s]+$/, "").trim());
      continue;
    }

    const opt = OPTION_LINE.exec(line);
    if (opt && current && current.type !== "section") {
      for (const part of opt[1].split(BOX_SPLIT)) {
        const clean = part.trim();
        if (!clean) continue;
        if (/_{2,}/.test(clean)) {
          otherLabels.set(current, clean.replace(/[:_\s]+$/, "").trim());
        } else {
          current.options.push(clean);
        }
      }
      continue;
    }

    const questionComplete =
      current !== null &&
      current.type !== "section" &&
      (current.options.length > 0 || /[.?:)]$/.test(current.text));
    if (
      (SECTION_LINE.test(line) && !/[?]$/.test(line)) ||
      ((questionComplete || !current) && looksLikeHeading(line))
    ) {
      finish();
      if (!title && drafts.length === 0) {
        title = line;
        continue;
      }
      current = { type: "section", text: line, help: "", options: [] };
      continue;
    }

    if (!title && drafts.length === 0 && !current) {
      title = line;
      continue;
    }

    if (current) {
      // A wrapped prompt continues until options start; after that, stray
      // lines are instructions.
      if (current.type === "section") {
        current.help = current.help ? `${current.help} ${line}` : line;
      } else if (current.options.length === 0 && !current.text.endsWith("?")) {
        current.text = `${current.text} ${line}`;
      } else if (current.options.length > 0) {
        current.options[current.options.length - 1] += ` ${line}`;
      } else {
        current.help = current.help ? `${current.help} ${line}` : line;
      }
    } else if (drafts.length === 0) {
      intro.push(line);
    }
  }
  finish();

  return {
    title: title.slice(0, 200),
    description: intro.join(" ").slice(0, MAX_QUESTION_TEXT),
    questions: normalizeSurveyQuestions(
      drafts.map((d) => ({
        ...d,
        otherLabel: otherLabels.get(d) ?? "",
        required: d.type !== "textarea",
      })),
    ),
  };
}

// ─── AI extraction ───────────────────────────────────────────────────────────

export const SURVEY_EXTRACTION_SCHEMA = {
  name: "survey_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: [...SURVEY_QUESTION_TYPES] },
            text: { type: "string" },
            help: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            other_label: { type: "string" },
            required: { type: "boolean" },
          },
          required: [
            "type",
            "text",
            "help",
            "options",
            "other_label",
            "required",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "description", "questions"],
    additionalProperties: false,
  },
} as const;

export function buildSurveyExtractionPrompt(sourceText: string): string {
  return `You convert a research survey, given as text extracted from a PDF, into structured questions for an online form.

Rules:
- Keep every question, in order, with its wording unchanged. Do not invent, merge or drop questions.
- Use "section" for headings or instruction blocks (put the instructions in "help", leave "options" empty).
- Use "likert" for agreement/frequency/quality rating scales. When a grid of statements shares one scale, emit one "likert" question per statement, each repeating the full scale as its options, lowest to highest.
- Use "single" for pick-one lists, "multi" when the respondent may select several ("select all that apply").
- Use "text" for short free answers (a name, a number, one line) and "textarea" for open-ended explanations.
- Options are the answer labels only, without their letters or checkbox glyphs. Keep a scale's numbers in the label when only some points are named (e.g. "1 - Strongly disagree", "2", "3", "4", "5 - Strongly agree").
- When a choice list has a write-in option ("Other ____", "Prefer to self-describe: ____"), put its label (without the blank) in "other_label" and leave it out of "options"; otherwise "other_label" is "".
- A write-in box marked "does not apply" means the question is optional.
- Set "required" to false for optional or open-ended comment questions, true otherwise.
- Omit any consent-to-contact, signature, or interview sign-up block: the platform adds its own.
- "title" is the survey's title; "description" is its introduction (may be empty).

Survey text:
"""
${sourceText.slice(0, MAX_SOURCE_TEXT)}
"""`;
}

export function normalizeExtractedSurvey(input: unknown): ParsedSurvey {
  const r =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  return {
    title: cleanText(r.title, 200),
    description: cleanText(r.description, MAX_QUESTION_TEXT),
    questions: normalizeSurveyQuestions(
      (Array.isArray(r.questions) ? r.questions : []).map((q) =>
        q && typeof q === "object"
          ? {
              ...(q as Record<string, unknown>),
              otherLabel: (q as Record<string, unknown>).other_label,
            }
          : q,
      ),
    ),
  };
}
