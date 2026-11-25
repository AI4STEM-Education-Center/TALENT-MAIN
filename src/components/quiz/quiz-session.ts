import type { QuizQuestionExclusionOptions } from "@/lib/alternative-retake";
import type { UnifiedQuizOverview } from "@/lib/quiz-overview";
export type { UnifiedQuizOverview } from "@/lib/quiz-overview";

import { scoreQuiz, type SubmittedAnswer } from "@/lib/quiz-scoring";
import { shuffleAnswerChoices } from "@/lib/quiz-shuffle";

export interface QuizQuestion {
  id: string;
  text: string;
  answerMode: string;
  answerUnit?: string | null;
  figureUrl?: string | null;
  figureAlt?: string | null;
  options: {
    id: string;
    text: string;
    imageUrl?: string | null;
    imageAlt?: string | null;
  }[];
}

export interface QuizResult {
  score: number;
  incorrectQuestionIds: string[];
  /** Practice only: the recorded retake's attempt id (results are keyed by it). */
  quizAttemptId?: string;
}

export interface QuizSession {
  // Only real student sessions have a persisted attempt and AI results.
  attemptId?: string;
  versionName?: string;
  /** Previously-correct questions left out of this retake. */
  excludedCount?: number;
  /** Exclusion was requested but nothing would remain. */
  exclusionIgnored?: boolean;
  questions: QuizQuestion[];
  submit: (answers: SubmittedAnswer[]) => Promise<QuizResult>;
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? "Could not load or submit quiz.");
  }
  return response.json();
}

export async function fetchUnifiedQuizOverview(
  classId: string,
  quizId: string,
): Promise<UnifiedQuizOverview> {
  const query = new URLSearchParams({ classId, quizId });
  return readResponse<UnifiedQuizOverview>(
    await fetch(`/api/quiz?${query}`, { cache: "no-store" }),
  );
}

export async function startStudentQuiz(
  classId: string,
  quizId: string,
  options: QuizQuestionExclusionOptions = {},
): Promise<QuizSession> {
  const data = await readResponse<{
    attemptId: string;
    excludedCount: number;
    exclusionIgnored: boolean;
    questions: QuizQuestion[];
  }>(
    await fetch("/api/quiz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId, quizId, ...options }),
    }),
  );
  return {
    ...data,
    submit: async (answers) =>
      readResponse<QuizResult>(
        await fetch("/api/quiz", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attemptId: data.attemptId, answers }),
        }),
      ),
  };
}

type PreviewQuestion = QuizQuestion & {
  answerNumeric?: number | null;
  answerTolerance?: number | null;
  options: (QuizQuestion["options"][number] & { isCorrect: boolean })[];
};

export async function startQuizPreview(quizId: string): Promise<QuizSession> {
  // This existing read endpoint enforces teacher/admin content access. Its
  // answer key stays in this closure; the player receives student-shaped data.
  // No attempt, answer, progress, result, or background job is created.
  const quiz = await readResponse<{ questions: PreviewQuestion[] }>(
    await fetch(`/api/quizzes/${encodeURIComponent(quizId)}`, {
      cache: "no-store",
    }),
  );
  if (quiz.questions.length === 0) {
    throw new Error("No questions available for this quiz.");
  }
  const seed = crypto.randomUUID();
  const questionsById = new Map(quiz.questions.map((q) => [q.id, q]));
  return {
    questions: quiz.questions.map((q) => ({
      id: q.id,
      text: q.text,
      answerMode: q.answerMode,
      answerUnit: q.answerUnit,
      figureUrl: q.figureUrl,
      figureAlt: q.figureAlt,
      options: shuffleAnswerChoices(q.options, `${seed}:${q.id}`).map((o) => ({
        id: o.id,
        text: o.text,
        imageUrl: o.imageUrl,
        imageAlt: o.imageAlt,
      })),
    })),
    submit: async (answers) => {
      const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
      const result = scoreQuiz({
        attemptId: "preview",
        questionsById,
        answers: quiz.questions.map(
          (q) => byQuestion.get(q.id) ?? { questionId: q.id },
        ),
        totalQuestions: quiz.questions.length,
      });
      return {
        score: result.score,
        incorrectQuestionIds: result.answerRecords.flatMap((a) =>
          a.isCorrect ? [] : [a.questionId],
        ),
      };
    },
  };
}

export async function startPracticeQuiz(
  classId: string,
  quizId: string,
  options: QuizQuestionExclusionOptions | boolean = false,
): Promise<QuizSession> {
  const data = await readResponse<{
    attemptId: string;
    quizAttemptId: string | null;
    versionName: string;
    excludedCount: number;
    exclusionIgnored: boolean;
    questions: QuizQuestion[];
  }>(
    await fetch("/api/quiz/practice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classId,
        quizId,
        ...(typeof options === "boolean"
          ? { excludeCorrect: options }
          : options),
      }),
    }),
  );
  return {
    ...data,
    // Results are keyed by the recorded QuizAttempt; submit by the practice id.
    attemptId: data.quizAttemptId ?? undefined,
    submit: async (answers) =>
      readResponse<QuizResult>(
        await fetch("/api/quiz/practice", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attemptId: data.attemptId, answers }),
        }),
      ),
  };
}
