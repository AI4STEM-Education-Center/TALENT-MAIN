import type {
  VariantQuestion,
  Objective,
  QuestionRevision,
  VariantMix,
  VerificationReview,
} from "@/lib/quiz-variants";

export type { QuestionRevision, VariantMix, VerificationReview };

export type SourceQuestion = {
  id: string;
  text: string;
  answerMode: string;
  feedbackGeneral?: string | null;
  options: {
    id?: string;
    text: string;
    isCorrect: boolean;
    imageUrl?: string | null;
  }[];
  answerTolerance?: number | null;
  answerNumeric?: number | null;
  answerUnit?: string | null;
  figureUrl?: string | null;
};

export type Version = {
  id: string;
  name: string;
  variation: string;
  status: string;
  purpose: string;
  batchId: string | null;
  slotIndex?: number;
  createdAt: string;
  questions: VariantQuestion[];
  sourceSnapshot: VariantQuestion[];
  objectives: Objective[];
  feedback?: string | null;
  questionFeedback?: QuestionRevision[] | null;
  completedCount?: number;
  totalCount?: number;
  error: string | null;
  aiModel: string | null;
  validation: { sourceQuestionId: string; explanation: string }[] | null;
  standaloneQuiz: { id: string; name: string } | null;
};

export type VerifiedSampleItem = {
  question: VariantQuestion;
  check: VerificationReview;
};

export type SampleResponse = {
  sourceQuestionId: string;
  numbersSample: VerifiedSampleItem;
  contextSample: VerifiedSampleItem;
  aiModel: string;
};

export type SeedSamples = {
  numbersSample?: VerifiedSampleItem;
  contextSample?: VerifiedSampleItem;
};

export type ReviseBatchItem = {
  versionId: string;
  questionRevisions?: QuestionRevision[];
  feedback?: string;
};

/** Send a version change; resolves with the JSON body or throws its error. */
export type Act = (
  body: unknown,
  method?: "POST" | "PATCH",
) => Promise<Record<string, unknown> | null>;

export const MODES = [
  { value: "NUMBERS", label: "Numbers & choices" },
  { value: "CONTEXT", label: "Context, numbers & choices" },
] as const;

export const MIX_OPTIONS: {
  value: VariantMix;
  title: string;
  subtitle: string;
  numbersCount: number;
  contextCount: number;
}[] = [
  {
    value: "4-0",
    title: "All 4 Limited Numerical",
    subtitle: "4 numerical changes · 0 full rewrites",
    numbersCount: 4,
    contextCount: 0,
  },
  {
    value: "2-2",
    title: "2 + 2 Balanced Mix",
    subtitle: "2 numerical changes · 2 full rewrites",
    numbersCount: 2,
    contextCount: 2,
  },
  {
    value: "0-4",
    title: "All 4 Full Question Rewrite",
    subtitle: "0 numerical changes · 4 full rewrites",
    numbersCount: 0,
    contextCount: 4,
  },
];

export const DEFAULT_OBJECTIVE =
  "Preserve the original learning objective, reasoning steps, units, and difficulty.";

export const isGenerating = (v: Version) =>
  v.status === "QUEUED" || v.status === "GENERATING";

/** Whether a version was generated from the quiz exactly as it stands now. */
export function matchesSource(version: Version, questions: SourceQuestion[]) {
  return (
    version.sourceSnapshot.length === questions.length &&
    questions.every((q) =>
      version.sourceSnapshot.some(
        (source) =>
          source.id === q.id &&
          source.text === q.text &&
          JSON.stringify(source.options) ===
            JSON.stringify(
              q.options.map(({ id, text, isCorrect }) => ({
                id,
                text,
                isCorrect,
              })),
            ) &&
          (source.answerTolerance ?? null) === (q.answerTolerance ?? null) &&
          (source.answerNumeric ?? null) === (q.answerNumeric ?? null) &&
          (source.answerUnit ?? null) === (q.answerUnit ?? null),
      ),
    )
  );
}
