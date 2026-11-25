import type { QuizAvailability } from "./quiz-availability";

export type UnifiedQuizOverview = {
  classId: string;
  quiz: { id: string; name: string; topicName: string | null };
  availability: QuizAvailability;
  availableFrom: string | null;
  availableUntil: string | null;
  maxAttempts: number | null;
  gradedAttemptCount: number;
  gradedAttempt: {
    id: string;
    startedAt: string;
    excludedQuestionIds: string[];
  } | null;
  practiceAvailableCount: number;
  practiceCanStart: boolean;
  practiceAttempt: {
    id: string;
    quizAttemptId: string | null;
    versionName: string;
    startedAt: string;
  } | null;
  previouslyCorrect: string[];
  questions: { id: string; number: number; previewText: string }[];
  recentAttempts: {
    id: string;
    kind: "official" | "alternative";
    versionName: string | null;
    score: number | null;
    excludedCount: number;
    startedAt: string;
    completedAt: string | null;
  }[];
};
