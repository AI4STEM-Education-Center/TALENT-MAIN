import type { VariantQuestion, Objective } from "@/lib/quiz-variants";

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
  createdAt: string;
  questions: VariantQuestion[];
  sourceSnapshot: VariantQuestion[];
  objectives: Objective[];
  error: string | null;
  aiModel: string | null;
  validation: { sourceQuestionId: string; explanation: string }[] | null;
  standaloneQuiz: { id: string; name: string } | null;
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
