// Pure exam-result helpers: building the durable review snapshot, adapting that
// snapshot into the shapes the summary/recommendation generators expect, and
// mapping stored recommendations to presigned image URLs. Everything here is
// pure (no DB / LLM / S3 / Next imports) so it can be unit-tested like
// `chat-prompt.ts` and `recommendation.ts`. The impure orchestration that calls
// the LLM / Prisma / S3 lives in `exam-results-engine.ts`.

import type { MisconceptionInput } from "./recommendation";
import type { QuizReviewAttempt } from "./chat-prompt";

/** Generation status for the two async AI sections of an ExamResult. */
export const RESULT_STATUS = {
  PENDING: "PENDING",
  GENERATING: "GENERATING",
  READY: "READY",
  FAILED: "FAILED",
} as const;
export type ResultStatus = (typeof RESULT_STATUS)[keyof typeof RESULT_STATUS];

/** At most one recommendation per wrong question, capped. Mirrors the chatbot. */
export const MAX_RECOMMENDATIONS = 6;

// ─── Review snapshot ──────────────────────────────────────────────────────────

export type SnapshotOption = { text: string; isCorrect: boolean; selected: boolean };
export type SnapshotQuestion = {
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
  options: { id: string; text: string; isCorrect: boolean }[];
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
        text: q.text,
        isCorrect: answer?.isCorrect ?? false,
        options: q.options.map((opt) => ({
          text: opt.text,
          isCorrect: opt.isCorrect,
          selected: selected.has(opt.id),
        })),
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

const joinTexts = (opts: SnapshotOption[], pick: (o: SnapshotOption) => boolean): string[] =>
  opts.flatMap((o) => (pick(o) ? [o.text] : []));

/** Append a unit suffix (e.g. "9.8 m/s^2"). LaTeX in the unit passes through raw. */
const withUnit = (value: string, unit: string | null | undefined): string =>
  unit ? `${value} ${unit}` : value;

/** True for snapshot questions persisted from a NUMERIC question (no options). */
const isNumeric = (q: SnapshotQuestion): boolean => q.answerMode === "NUMERIC";

/** Student-facing text of a NUMERIC submission, or "No answer" when absent. */
const numericWrongAnswer = (q: SnapshotQuestion): string =>
  q.submittedNumeric != null ? withUnit(String(q.submittedNumeric), q.unit) : "No answer";

/** Text of a NUMERIC question's correct value (always present for a graded q). */
const numericCorrectAnswer = (q: SnapshotQuestion): string =>
  withUnit(String(q.correctNumeric), q.unit);

/**
 * Derive the misconception inputs for the recommendation engine from the
 * snapshot's incorrect questions. Capped at `maxCount`; reports whether more
 * wrong answers existed than were kept.
 */
export function snapshotToMisconceptions(
  snapshot: ReviewSnapshot,
  maxCount: number = MAX_RECOMMENDATIONS
): { inputs: MisconceptionInput[]; truncated: boolean } {
  const wrong = snapshot.questions.filter((q) => !q.isCorrect);
  const truncated = wrong.length > maxCount;
  const inputs = wrong.slice(0, maxCount).map((q) => {
    // NUMERIC questions carry no options; surface the submitted/correct numbers
    // (+unit) instead of option text. Choice questions are byte-identical.
    if (isNumeric(q)) {
      return {
        questionText: q.text,
        wrongAnswer: numericWrongAnswer(q),
        correctAnswer: numericCorrectAnswer(q),
      };
    }
    const selected = joinTexts(q.options, (o) => o.selected);
    const correct = joinTexts(q.options, (o) => o.isCorrect);
    return {
      questionText: q.text,
      wrongAnswer: selected.length > 0 ? selected.join(" | ") : "No answer selected",
      correctAnswer: correct.length > 0 ? correct.join(" | ") : null,
    };
  });
  return { inputs, truncated };
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
          options: q.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
        },
      };
    }),
  };
}

// ─── Stored recommendations ─────────────────────────────────────────────────────

/** A page kept in the DB: storageKey (NOT a presigned URL — those expire). */
export type StoredRecPage = { pageNumber: number; storageKey: string };
export type StoredRecommendation = {
  questionText: string;
  materialTitle: string;
  pageRange: { start: number; end: number };
  fileReason: string;
  pageReason: string;
  pages: StoredRecPage[];
};
export type StoredRecommendations = { items: StoredRecommendation[]; truncated: boolean };

/** A page ready for the client: presigned, short-lived image URL. */
export type PresignedRecPage = { pageNumber: number; imageUrl: string };
export type PresignedRecommendation = Omit<StoredRecommendation, "pages"> & {
  pages: PresignedRecPage[];
};
export type PresignedRecommendations = { items: PresignedRecommendation[]; truncated: boolean };

/** Safely parse the stored recommendations JSON blob. */
export function parseStoredRecommendations(raw: string | null): StoredRecommendations {
  if (!raw) return { items: [], truncated: false };
  try {
    const parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      truncated: parsed?.truncated === true,
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
      const pages: PresignedRecPage[] = [];
      for (const pg of rec.pages) {
        try {
          pages.push({ pageNumber: pg.pageNumber, imageUrl: await presign(pg.storageKey) });
        } catch {
          // Skip a page we can't presign; keep the rest of the recommendation.
        }
      }
      const { pages: _omit, ...rest } = rec;
      return { ...rest, pages };
    })
  );
  return { items, truncated: stored.truncated };
}
