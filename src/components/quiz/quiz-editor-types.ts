import type { DisplayAiMetrics } from "@/lib/ai-metrics";

export type AnswerMode = "SINGLE_SELECT" | "MULTI_SELECT" | "NUMERIC";
// hasImage is the durable "this option is an image choice" signal; imageUrl is
// a transient presigned URL that can be null even when a stored crop exists.
export interface Option {
  id?: string;
  text: string;
  isCorrect: boolean;
  imageUrl?: string | null;
  imageAlt?: string | null;
  hasImage?: boolean;
}
export interface QuestionSimulation {
  id: string;
  status: string;
  title: string | null;
  declineReason: string | null;
  errorMessage: string | null;
  hasContent: boolean;
  aiMetrics: DisplayAiMetrics;
}
export interface Question {
  id: string;
  title?: string | null;
  text: string;
  difficultyLevel: string;
  answerMode: AnswerMode;
  points?: number | null;
  feedbackGeneral?: string | null;
  sourceQuestionId?: string | null;
  simulation?: QuestionSimulation | null;
  options: Option[];
  // NUMERIC questions only.
  answerNumeric?: number | null;
  answerTolerance?: number | null;
  answerUnit?: string | null;
  // Presigned transient figure URL (from attachFigureUrls); never the raw key.
  figureUrl?: string | null;
  figureAlt?: string | null;
}
export interface Topic {
  id: string;
  name: string;
}
export interface QuizDetail {
  id: string;
  name: string;
  topicId: string | null;
  topic: Topic | null;
  teacherId: string | null;
  questions: Question[];
  editable: boolean;
}
export interface ImportSummary {
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  bankTitle?: string;
  errors?: { index: number; sourceQuestionId?: string; message: string }[];
}

// FormOption carries imageUrl/imageAlt so image answer-choices survive an
// edit round-trip; blank text-only rows are what new questions start from.
export type FormOption = {
  id: string;
  text: string;
  isCorrect: boolean;
  imageUrl?: string | null;
  imageAlt?: string | null;
  hasImage?: boolean;
};
