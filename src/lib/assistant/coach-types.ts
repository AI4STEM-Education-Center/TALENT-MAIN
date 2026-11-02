// Shared types for the per-question "wrong-answer coach". Dependency-free like
// types.ts (type-only imports, no Prisma/Next) so the dialog component, the
// route handlers and the tool handlers all agree on one shape.
//
// Two forms of every action exist on purpose:
//   - a REF is what the server stores in AssistantMessage.actions and what a
//     tool returns: ids and model-written text only, nothing that expires;
//   - a VIEW is the hydrated card the client renders (presigned page URLs,
//     live simulation versions, a student-safe practice question). Views are
//     rebuilt from refs — with the access checks repeated — every time a
//     transcript is reopened, so a revoked enrollment or a retired version
//     simply stops rendering instead of leaking from a stale copy.

import type {
  PresignedRecommendation,
  SnapshotQuestion,
  StudentMistakeView,
} from "@/lib/exam-results";

/** Longest model-written one-liner shown on a card. */
export const COACH_REASON_MAX = 240;
/** A simulation how-to is a few concrete steps, not a lesson. */
export const COACH_STEPS_MIN = 2;
export const COACH_STEPS_MAX = 6;
export const COACH_STEP_MAX = 280;
export const COACH_OBSERVE_MAX = 320;
/** Most cards one coach reply may surface. */
export const COACH_MAX_ACTIONS_PER_TURN = 2;

/** The coach tool names, shared by the tool registry, prompt and tests. */
export const COACH_TOOL_NAMES = [
  "recommend_material",
  "explain_simulation",
  "offer_practice_question",
] as const;
export type CoachToolName = (typeof COACH_TOOL_NAMES)[number];

/**
 * Which question the dialog is about, resolved server-side from the session.
 * Nothing in here comes from the model; handlers read it from the tool context
 * and can therefore only ever act on the question the student opened.
 */
export type CoachScope = {
  studentId: string;
  /** QuizAttempt id — also the ExamResult.quizAttemptId the page was opened with. */
  resultId: string;
  /** 1-based position in the review snapshot, as the mistakes list numbers it. */
  questionNumber: number;
  classId: string;
  quizId: string;
  quizName: string;
  topicName: string;
  className: string;
  /** Live Question.id from the snapshot; absent on pre-questionId snapshots. */
  questionId: string | null;
  question: SnapshotQuestion;
  /**
   * Set when the attempt is an alternative-version retake. Its snapshot holds
   * the variant's questions under their SOURCE question ids, and it is never
   * final: the student can always practise another version, so the key stays
   * withheld (like get_quiz_result_detail) whatever the graded allowance says.
   */
  alternativeVersionName: string | null;
  /** The version that retake was run on; never offered back as "new" practice. */
  ownVersionId: string | null;
  /**
   * False while the student could still retake the quiz. The results page is
   * deliberately answer-key-free, so the coach is too until the attempt is
   * final (same rule as the assistant's get_quiz_result_detail tool).
   */
  answerKeyAvailable: boolean;
};

// ─── Stored references ───────────────────────────────────────────────────────

export type CoachMaterialRef = {
  kind: "material";
  /** Index into the attempt's stored recommendation items. */
  recommendationIndex: number;
  reason: string;
};
export type CoachSimulationRef = {
  kind: "simulation";
  simulationId: string;
  goal: string;
  steps: string[];
  observe: string;
};
export type CoachPracticeRef = {
  kind: "practice";
  versionId: string;
  /** The variant question's own id inside the published version. */
  variantQuestionId: string;
  reason: string;
};
export type CoachActionRef =
  CoachMaterialRef | CoachSimulationRef | CoachPracticeRef;

// ─── Client views ────────────────────────────────────────────────────────────

/** An existing alternative-version question, with no key and no solution. */
export type CoachPracticeQuestionView = {
  versionId: string;
  questionId: string;
  text: string;
  answerMode: "SINGLE_SELECT" | "NUMERIC";
  answerUnit: string | null;
  options: { id: string; text: string }[];
};

export type CoachActionView =
  | {
      kind: "material";
      reason: string;
      recommendation: PresignedRecommendation;
    }
  | {
      kind: "simulation";
      simulation: {
        simulationId: string;
        title: string;
        topic: string | null;
        learningGoal: string | null;
        version: number;
      };
      goal: string;
      steps: string[];
      observe: string;
    }
  | {
      kind: "practice";
      reason: string;
      question: CoachPracticeQuestionView;
    };

/**
 * The original question, as the dialog's reference pane shows it. `response`
 * is exactly what the results page already shows; `review` is present only
 * once the attempt is final, because it carries the answer key.
 */
export type CoachQuestionView = {
  questionNumber: number;
  quizName: string;
  text: string;
  figureUrl: string | null;
  figureAlt: string | null;
  response: StudentMistakeView["response"];
  review: null | {
    choices: {
      text: string;
      imageUrl: string | null;
      imageAlt: string | null;
      selected: boolean;
      correct: boolean;
    }[];
    /** NUMERIC only. */
    correctNumeric: number | null;
    unit: string | null;
    /** The teacher's authored explanation, when the question has one. */
    explanation: string | null;
  };
};

export type CoachTurnView = {
  role: "user" | "assistant";
  content: string;
  actions: CoachActionView[];
};

/** GET /api/assistant/coach response. */
export type CoachSessionView = {
  question: CoachQuestionView;
  opening: string;
  conversationId: string | null;
  turns: CoachTurnView[];
};

/** POST /api/assistant/coach/practice response. */
export type CoachPracticeResult = { correct: boolean };
