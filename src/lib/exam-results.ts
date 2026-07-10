// Pure exam-result helpers: building the durable review snapshot, adapting that
// snapshot into the shapes the summary/recommendation generators expect, and
// mapping stored recommendations to presigned image URLs. Everything here is
// pure (no DB / LLM / S3 / Next imports) so it can be unit-tested like
// `chat-prompt.ts` and `recommendation.ts`. The impure orchestration that calls
// the LLM / Prisma / S3 lives in `exam-results-engine.ts`.

import type { HolisticAttempt } from "./recommendation";
import type { QuizReviewAttempt } from "./chat-prompt";

/** Generation status for the two async AI sections of an ExamResult. */
export const RESULT_STATUS = {
  PENDING: "PENDING",
  GENERATING: "GENERATING",
  READY: "READY",
  FAILED: "FAILED",
} as const;
export type ResultStatus = (typeof RESULT_STATUS)[keyof typeof RESULT_STATUS];

/** At most this many holistic study-material recommendations per attempt. */
export const MAX_RECOMMENDATIONS = 3;

// ─── Review snapshot ──────────────────────────────────────────────────────────

export type SnapshotOption = {
  text: string;
  isCorrect: boolean;
  selected: boolean;
  // Image answer-choice (omitted entirely for text options so existing
  // choice-only snapshots stay byte-identical):
  imageStorageKey?: string | null;
  imageAlt?: string | null;
  // TRANSIENT, render-time only: a presigned GET URL attached by callers just
  // before rendering. buildReviewSnapshot never sets it; never persist it.
  imageUrl?: string | null;
};
export type SnapshotQuestion = {
  // Durable identifier used to attach teacher-only misconception labels to the
  // exact quiz error. Optional so snapshots created before this field existed
  // remain readable.
  questionId?: string;
  text: string;
  isCorrect: boolean;
  options: SnapshotOption[];
  // NUMERIC questions only (omitted entirely for choice questions so old
  // choice-only snapshots stay byte-identical):
  answerMode?: string;
  correctNumeric?: number | null;
  tolerance?: number | null;
  unit?: string | null;
  submittedNumeric?: number | null;
  // Any question that carried a figure (omitted when absent):
  figureStorageKey?: string | null;
  figureAlt?: string | null;
  // TRANSIENT, render-time only: a presigned GET URL attached by callers just
  // before rendering (server pages presign from figureStorageKey; the student
  // quiz page reuses the figureUrl it already received). buildReviewSnapshot
  // never sets it and it must never be persisted.
  figureUrl?: string | null;
};
export type ReviewSnapshot = { questions: SnapshotQuestion[] };

/**
 * A question as it exists at submit time (live options carry ids + isCorrect).
 * The numeric/figure fields are OPTIONAL so existing callers (e.g. the inline
 * results view in the student quiz page) compile unchanged.
 */
export type SnapshotQuestionInput = {
  id: string;
  text: string;
  options: {
    id: string;
    text: string;
    isCorrect: boolean;
    imageStorageKey?: string | null;
    imageBucket?: string | null;
    imageAlt?: string | null;
  }[];
  answerMode?: string;
  answerNumeric?: number | null;
  answerTolerance?: number | null;
  answerUnit?: string | null;
  figureStorageKey?: string | null;
  figureAlt?: string | null;
};

/** A graded answer record (selection already normalized to a string[] of ids). */
export type SnapshotAnswerInput = {
  questionId: string;
  selectedOptionIds: string[];
  isCorrect: boolean;
  numericValue?: number | null;
};

/**
 * Build the self-contained review snapshot from the questions and graded
 * answers available at submit time. The snapshot stores option text + flags
 * only (no ids), so it renders forever even if the live Question/Option rows
 * are later edited or deleted.
 */
export function buildReviewSnapshot(
  questions: SnapshotQuestionInput[],
  answers: SnapshotAnswerInput[]
): ReviewSnapshot {
  const answerByQuestion = new Map(answers.map((a) => [a.questionId, a]));
  return {
    questions: questions.map((q) => {
      const answer = answerByQuestion.get(q.id);
      const selected = new Set(answer?.selectedOptionIds ?? []);
      const base: SnapshotQuestion = {
        questionId: q.id,
        text: q.text,
        isCorrect: answer?.isCorrect ?? false,
        options: q.options.map((opt) => {
          const snap: SnapshotOption = {
            text: opt.text,
            isCorrect: opt.isCorrect,
            selected: selected.has(opt.id),
          };
          // Image answer-choice: persist its key + alt (omitted for text options
          // so plain choice snapshots stay byte-identical).
          if (opt.imageStorageKey) {
            snap.imageStorageKey = opt.imageStorageKey;
            snap.imageAlt = opt.imageAlt ?? null;
          }
          return snap;
        }),
      };
      // NUMERIC questions carry no options; persist the numeric grading data and
      // the student's submitted value so the durable snapshot can render/score
      // without the live rows. Choice questions stay byte-identical (no keys).
      if (q.answerMode === "NUMERIC") {
        base.answerMode = q.answerMode;
        base.correctNumeric = q.answerNumeric ?? null;
        base.tolerance = q.answerTolerance ?? null;
        base.unit = q.answerUnit ?? null;
        base.submittedNumeric = answer?.numericValue ?? null;
      }
      // Figure fields apply to any question that carries one.
      if (q.figureStorageKey) {
        base.figureStorageKey = q.figureStorageKey;
        base.figureAlt = q.figureAlt ?? null;
      }
      return base;
    }),
  };
}

/** Safely parse a stored review snapshot, returning an empty one on bad JSON. */
export function parseReviewSnapshot(raw: string | null): ReviewSnapshot {
  if (!raw) return { questions: [] };
  try {
    const parsed = JSON.parse(raw);
    return { questions: Array.isArray(parsed?.questions) ? parsed.questions : [] };
  } catch {
    return { questions: [] };
  }
}

// ─── Snapshot → generator inputs ────────────────────────────────────────────────

/** Display text for an option — its alt/caption when the choice is an image. */
const optionDisplayText = (o: SnapshotOption): string =>
  o.text || o.imageAlt || (o.imageStorageKey ? "(image choice)" : "");

const joinTexts = (opts: SnapshotOption[], pick: (o: SnapshotOption) => boolean): string[] =>
  opts.flatMap((o) => (pick(o) ? [optionDisplayText(o)] : []));

/** True for snapshot questions persisted from a NUMERIC question (no options). */
const isNumeric = (q: SnapshotQuestion): boolean => q.answerMode === "NUMERIC";

/**
 * Derive the HOLISTIC recommendation input from the whole snapshot: every
 * question's text + correctness, plus aggregate right/wrong counts. The
 * recommendation engine uses this to pick materials across the whole attempt,
 * and the prompts (see recommendation.ts) deliberately never reveal which
 * specific questions were wrong.
 */
export function snapshotToHolisticInput(snapshot: ReviewSnapshot): HolisticAttempt {
  const questions = snapshot.questions.map((q) => ({
    questionText: q.text,
    isCorrect: q.isCorrect,
  }));
  const incorrectCount = questions.filter((q) => !q.isCorrect).length;
  return {
    questions,
    correctCount: questions.length - incorrectCount,
    incorrectCount,
  };
}

/**
 * Adapt the snapshot (plus score/identity metadata) into the `QuizReviewAttempt`
 * shape that `buildQuizReviewPrompt` consumes, so the summary can be generated
 * entirely from the durable snapshot rather than the live attempt rows.
 */
export function snapshotToSummaryAttempt(
  snapshot: ReviewSnapshot,
  meta: {
    score: number | null;
    completedAt: Date | null;
    className: string;
    topicName: string;
    quizName: string;
  }
): QuizReviewAttempt {
  return {
    score: meta.score,
    completedAt: meta.completedAt,
    class: { name: meta.className },
    quiz: { name: meta.quizName, topic: meta.topicName ? { name: meta.topicName } : null },
    answers: snapshot.questions.map((q) => {
      // NUMERIC questions carry the submitted/correct numbers through to the
      // prompt builder (which formats them, +unit); choice answers stay
      // byte-identical, leaving the numeric fields undefined.
      if (isNumeric(q)) {
        return {
          isCorrect: q.isCorrect,
          selectedOption: null,
          numericValue: q.submittedNumeric ?? null,
          question: {
            text: q.text,
            options: [],
            answerMode: q.answerMode,
            answerNumeric: q.correctNumeric ?? null,
            answerUnit: q.unit ?? null,
          },
        };
      }
      const selected = joinTexts(q.options, (o) => o.selected);
      return {
        isCorrect: q.isCorrect,
        selectedOption: selected.length > 0 ? { text: selected.join(" | ") } : null,
        question: {
          text: q.text,
          options: q.options.map((o) => ({ text: optionDisplayText(o), isCorrect: o.isCorrect })),
        },
      };
    }),
  };
}

// ─── Stored recommendations ─────────────────────────────────────────────────────

/** A page kept in the DB: storageKey (NOT a presigned URL — those expire). */
export type StoredRecPage = { pageNumber: number; storageKey: string };
export type StoredRecommendation = {
  materialTitle: string;
  pageRange: { start: number; end: number };
  // Single holistic reason — never references a specific question or answer.
  reason: string;
  pages: StoredRecPage[];
};
export type StoredMisconception = { misconceptionId: string; statement: string };
export type StoredQuestionMisconceptions = {
  questionId: string | null;
  questionIndex: number;
  misconceptions: StoredMisconception[];
};

/**
 * An interactive simulation surfaced with the recommendations. Deliberately
 * carries no question reference — the simulation itself teaches only the broad
 * topic (enforced at generation time), so showing it during blind review leaks
 * nothing. Content is served via /api/simulations/[id]/content, so only the id
 * + display fields are stored.
 */
export type StoredSimulationRecommendation = {
  simulationId: string;
  title: string | null;
  topic: string | null;
  learningGoal: string | null;
};

/**
 * A simulation recommendation as served to the student results UI: the stored
 * ref plus an availability flag resolved at read time. ExamResult snapshots
 * are durable while simulations can be deleted by staff afterwards, so a
 * stored ref may point at nothing — the flag lets the UI say "no longer
 * available" instead of mounting an iframe that 404s.
 */
export type SimulationRecommendationView = StoredSimulationRecommendation & {
  unavailable?: boolean;
};

/**
 * Display identity of a simulation recommendation: normalized title + topic.
 * Two rows whose artifacts were built independently for same-topic questions
 * (so their storageKeys differ) still read as the same simulation to a student;
 * this key is what "the same simulation" means at display time. Falls back to
 * the id when a simulation carries no title/topic at all.
 */
export function simulationDisplayKey(sim: StoredSimulationRecommendation): string {
  const norm = (value: string | null) => value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  const key = `${norm(sim.title)}|${norm(sim.topic)}`;
  return key === "|" ? sim.simulationId : key;
}

/**
 * Drop simulations that duplicate an earlier entry's display identity, keeping
 * order. Applied when results are generated AND again at render time, because
 * ExamResult snapshots are durable — results stored before this dedup existed
 * still contain the duplicates.
 */
export function dedupeStoredSimulations<T extends SimulationRecommendationView>(
  simulations: T[]
): T[] {
  const availableKeys = new Set(
    simulations.filter((sim) => !sim.unavailable).map(simulationDisplayKey)
  );
  const seen = new Set<string>();
  return simulations.filter((sim) => {
    const key = simulationDisplayKey(sim);
    // An unavailable entry whose display identity is also carried by a live
    // entry is pure noise — the student can still open that simulation.
    if (sim.unavailable && availableKeys.has(key)) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type StoredRecommendations = {
  items: StoredRecommendation[];
  truncated: boolean;
  simulations?: StoredSimulationRecommendation[];
  // Teacher-only labels, attached to individual incorrect answers. Student
  // APIs and components must never expose this field.
  errorMisconceptions?: StoredQuestionMisconceptions[];
};

/** A page ready for the client: presigned, short-lived image URL. */
export type PresignedRecPage = { pageNumber: number; imageUrl: string };
export type PresignedRecommendation = Omit<StoredRecommendation, "pages"> & {
  pages: PresignedRecPage[];
};
export type PresignedRecommendations = {
  items: PresignedRecommendation[];
  truncated: boolean;
  simulations?: SimulationRecommendationView[];
  errorMisconceptions?: StoredQuestionMisconceptions[];
};

/** True for a value shaped like a valid StoredMisconception entry. */
function isStoredMisconception(value: unknown): value is StoredMisconception {
  if (!value || typeof value !== "object") return false;
  const entry = value as { misconceptionId?: unknown; statement?: unknown };
  return typeof entry.misconceptionId === "string" && typeof entry.statement === "string";
}

function isStoredQuestionMisconceptions(value: unknown): value is StoredQuestionMisconceptions {
  if (!value || typeof value !== "object") return false;
  const entry = value as {
    questionId?: unknown;
    questionIndex?: unknown;
    misconceptions?: unknown;
  };
  return (
    (entry.questionId === null || typeof entry.questionId === "string") &&
    Number.isInteger(entry.questionIndex) &&
    (entry.questionIndex as number) >= 0 &&
    Array.isArray(entry.misconceptions) &&
    entry.misconceptions.length >= 1 &&
    entry.misconceptions.length <= 3 &&
    entry.misconceptions.every(isStoredMisconception)
  );
}

function isStoredSimulationRecommendation(value: unknown): value is StoredSimulationRecommendation {
  if (!value || typeof value !== "object") return false;
  const entry = value as {
    simulationId?: unknown;
    title?: unknown;
    topic?: unknown;
    learningGoal?: unknown;
  };
  return (
    typeof entry.simulationId === "string" &&
    (entry.title === null || typeof entry.title === "string") &&
    (entry.topic === null || typeof entry.topic === "string") &&
    (entry.learningGoal === null || typeof entry.learningGoal === "string")
  );
}

/** Safely parse the stored recommendations JSON blob. */
export function parseStoredRecommendations(raw: string | null): StoredRecommendations {
  if (!raw) return { items: [], truncated: false };
  try {
    const parsed = JSON.parse(raw);
    const errorMisconceptions = Array.isArray(parsed?.errorMisconceptions)
      ? parsed.errorMisconceptions.filter(isStoredQuestionMisconceptions)
      : [];
    const simulations = Array.isArray(parsed?.simulations)
      ? parsed.simulations.filter(isStoredSimulationRecommendation)
      : [];
    return {
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      truncated: parsed?.truncated === true,
      ...(simulations.length > 0 ? { simulations } : {}),
      ...(errorMisconceptions.length > 0 ? { errorMisconceptions } : {}),
    };
  } catch {
    return { items: [], truncated: false };
  }
}

/**
 * Map stored recommendations (storageKeys) to presigned image URLs using the
 * injected `presign` function. A page whose presign fails is dropped rather
 * than failing the whole card (e.g. its underlying material was deleted), so
 * the textual recommendation still renders.
 */
export async function mapPresignedRecommendations(
  stored: StoredRecommendations,
  presign: (storageKey: string) => Promise<string>
): Promise<PresignedRecommendations> {
  const items = await Promise.all(
    stored.items.map(async (rec) => {
      // Presigns are independent per page, so fan them out; the original order
      // is preserved and a page we can't presign is dropped (kept null → filtered).
      const settled = await Promise.all(
        rec.pages.map(async (pg): Promise<PresignedRecPage | null> => {
          try {
            return { pageNumber: pg.pageNumber, imageUrl: await presign(pg.storageKey) };
          } catch {
            // Skip a page we can't presign; keep the rest of the recommendation.
            return null;
          }
        })
      );
      const pages = settled.filter((p): p is PresignedRecPage => p !== null);
      const { pages: _omit, ...rest } = rec;
      return { ...rest, pages };
    })
  );
  return {
    items,
    truncated: stored.truncated,
    ...(stored.simulations ? { simulations: stored.simulations } : {}),
    ...(stored.errorMisconceptions ? { errorMisconceptions: stored.errorMisconceptions } : {}),
  };
}
