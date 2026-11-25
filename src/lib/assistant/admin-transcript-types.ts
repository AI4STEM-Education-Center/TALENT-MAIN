// Shared client/server types for rich read-only cards in the Admin Chat
// Transcripts dialog. Dependency-free (type-only imports) so client components
// can import these without pulling Prisma or Node APIs into the browser bundle.

import type { PresignedRecommendation } from "@/lib/exam-results";
import type {
  CoachDiagnosticOptionsRef,
  CoachMaterialInteraction,
  CoachPracticeInteraction,
  CoachQuestionView,
  CoachSimulationInteraction,
} from "./coach-types";
import type { AssistantTurn } from "./types";

/** Hydrated practice question for admins/researchers (includes answer key). */
export type AdminPracticeQuestionView = {
  versionId: string;
  versionName: string;
  questionId: string;
  text: string;
  answerMode: "SINGLE_SELECT" | "NUMERIC";
  answerUnit: string | null;
  answerNumeric: number | null;
  options: { id: string; text: string; isCorrect: boolean }[];
};

export type AdminSimulationMeta = {
  simulationId: string;
  title: string;
  topic: string | null;
  learningGoal: string | null;
  version: number;
  playable: boolean;
};

export type AdminTranscriptCard = { cardId?: string } & (
  | CoachDiagnosticOptionsRef
  | {
      kind: "material";
      recommendationIndex: number;
      reason: string;
      /** Hydrated material with presigned pages, or null if the source record is gone. */
      recommendation: PresignedRecommendation | null;
      interaction?: CoachMaterialInteraction;
    }
  | {
      kind: "simulation";
      simulationId: string;
      /** Hydrated simulation metadata, or null if the simulation row is gone. */
      simulation: AdminSimulationMeta | null;
      goal: string;
      steps: string[];
      observe: string;
      interaction?: CoachSimulationInteraction;
    }
  | {
      kind: "practice";
      versionId: string;
      variantQuestionId: string;
      reason: string;
      questionText?: string;
      /** Hydrated variant question with options and key, or null if the version is gone. */
      question: AdminPracticeQuestionView | null;
      interaction?: CoachPracticeInteraction;
    }
);

export type AdminTranscriptTurn = AssistantTurn & {
  /** Hydrated rich cards for assistant turns, aligned with stored `actions`. */
  cards?: AdminTranscriptCard[];
};

export type AdminHydratedTranscript = {
  turns: AdminTranscriptTurn[];
  /** Original missed question (with review/key) for coach conversations. */
  coachQuestion: CoachQuestionView | null;
};
