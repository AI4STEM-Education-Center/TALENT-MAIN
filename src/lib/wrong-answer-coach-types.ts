// Shared types for the Wrong Answer Coach feature (pure types only).

export const COACH_STATES = [
  "AWAITING_EXPLANATION",
  "CLASSIFYING_FAILED",
  "AWAITING_SECOND_QUESTION",
  "AWAITING_HELDOUT_QUESTION",
  "GENERATING_TUTORING",
  "COMPLETED",
  "INCOMPLETE",
] as const;
export type CoachSessionState = (typeof COACH_STATES)[number];

export const COACH_VARIANT_ROLES = [
  "PRACTICE",
  "COACH_CHECK3",
  "COACH_HELDOUT",
] as const;
export type CoachVariantRole = (typeof COACH_VARIANT_ROLES)[number];

export const COACH_FLAG_CODES = [
  "CHECK2_DISAGREEMENT",
  "CHECK2_TIE",
  "CHECK2_PARSE_FAILURE",
  "CHECK2_LOW_CONFIDENCE",
  "MISSING_OPTION_LABEL",
  "TUTORING_FALLBACK",
  "TUTORING_PROVIDER_ERROR",
  "OFF_TOPIC",
  "PERSONAL_SUPPORT_NEEDED",
  "INCOMPLETE_SESSION",
  "REPEAT_EXPOSURE",
] as const;
export type CoachFlagCode = (typeof COACH_FLAG_CODES)[number];

export const COACH_REVIEW_DECISIONS = [
  "AGREE_DIAGNOSIS",
  "OVERRIDE_SLIP",
  "OVERRIDE_KNOWLEDGE_GAP",
  "OVERRIDE_MISCONCEPTION",
  "ESCALATED_FOLLOWUP",
  "DISMISSED",
] as const;
export type CoachReviewDecision = (typeof COACH_REVIEW_DECISIONS)[number];

export const COACH_MESSAGE_KINDS = [
  "OPENING_PROMPT",
  "STUDENT_EXPLANATION",
  "STUDENT_FREE_TEXT",
  "ANSWER_REFUSAL",
  "SUPPORT_REDIRECT",
  "OFF_TOPIC_REDIRECT",
  "SECOND_QUESTION_PROMPT",
  "SECOND_QUESTION_ANSWER",
  "HELDOUT_PROMPT",
  "HELDOUT_ANSWER",
  "TUTORING_MESSAGE",
  "TUTORING_FALLBACK",
] as const;
export type CoachMessageKind = (typeof COACH_MESSAGE_KINDS)[number];

export type CoachDiagnosisKind = "SLIP" | "KNOWLEDGE_GAP" | "MISCONCEPTION";

export type CoachOptionLabel = {
  optionId: string;
  optionText: string;
  isCorrect: boolean;
  misconceptionCode: string | null;
  confidence?: number | null;
};

export type CoachMisconceptionEntry = {
  code: string;
  statement: string;
};

export type CoachVariantOptionSnapshot = {
  id: string;
  text: string;
  isCorrect: boolean;
  misconceptionCode: string | null;
};

export type CoachVariantQuestionSnapshot = {
  id: string;
  sourceQuestionId: string;
  text: string;
  options: CoachVariantOptionSnapshot[];
};

export type CoachMaterialSnippet = {
  materialId: string;
  title: string;
  pageNumber: number | null;
  text: string;
  sha256: string;
};

export type CoachFrozenSessionSnapshot = {
  protocolRevision: string;
  sourceHash: string;
  originalQuestion: {
    questionId: string;
    text: string;
    options: CoachOptionLabel[];
    correctOptionId: string;
    correctOptionText: string;
  };
  keyPoints: string[];
  relevantMisconceptions: CoachMisconceptionEntry[];
  secondQuestion: CoachVariantQuestionSnapshot;
  heldOutQuestion: CoachVariantQuestionSnapshot;
  courseSnippets: CoachMaterialSnippet[];
};

export type Check2RunSlot = {
  runIndex: number;
  settled: boolean;
  valid: boolean;
  retried: boolean;
  choice: string | null;
  parsedKind: "misconception" | "sound" | "neither";
  misconceptionCode: string | null;
  normalizedVoteKey: string;
  probabilities: Array<{ value: string; probability: number }>;
  confidence: number | null;
  evidence: string | null;
  rawResponse: string | null;
  retryRawResponse?: string | null;
  error?: string | null;
  model: string;
  latencyMs: number;
};

export type OpaqueMcqTokenEntry = {
  optionToken: string;
  variantOptionId: string;
  label: string; // "A", "B", "C", ...
  text: string;
};

export type StructuredTutoringMessage = {
  correctAnswerText: string;
  bodyParagraphs: string[];
  keyPoints?: string[];
  usedFallback: boolean;
};

export type TutoringAttemptRecord = {
  attempt: number;
  rawText: string | null;
  parsedBody: string | null;
  valid: boolean;
  failureReasons: string[];
  providerError?: string | null;
  model: string | null;
  latencyMs: number;
};

export type CoachEligibilityItem = {
  questionId: string;
  questionNumber: number;
  eligible: boolean;
  sessionId: string | null;
  sessionStatus: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "INCOMPLETE";
};

export type StudentCoachOptionView = {
  label: string;
  text: string;
  isChosen: boolean;
  // ONLY populated when state === "COMPLETED" (after Step 10!).
  isCorrect?: boolean;
};

export type StudentAnsweredMcqView = {
  step: "second_question" | "held_out_question";
  text: string;
  options: StudentCoachOptionView[];
  // ONLY populated when state === "COMPLETED" (after Step 10!).
  isCorrect?: boolean;
};

export type StudentCoachSessionView = {
  sessionId: string;
  attemptId: string;
  questionId: string;
  questionNumber: number;
  state: CoachSessionState;
  originalQuestion: {
    text: string;
    chosenOptionText: string;
    options: StudentCoachOptionView[];
    // ONLY populated when state === "COMPLETED" (after Step 10!).
    correctOptionText?: string;
  };
  messages: Array<{
    seq: number;
    role: "system" | "student" | "assistant";
    kind: string;
    content: string;
    structuredTutoring?: StructuredTutoringMessage | null;
    createdAt: string;
  }>;
  answeredMcqs: StudentAnsweredMcqView[];
  activeMcq: {
    step: "second_question" | "held_out_question";
    text: string;
    options: Array<{ optionToken: string; label: string; text: string }>;
  } | null;
};
