import seedData from "./prebuilt-questions.json";

export type QuestionData = {
  text: string;
  subtopicId: string;
  difficulty: string;
  options: { text: string; isCorrect: boolean }[];
};

type PrebuiltTopic = {
  id: string;
  name: string;
  order: number;
};

type PrebuiltSubtopic = {
  id: string;
  name: string;
  order: number;
};

type PrebuiltSeedData = {
  topic: PrebuiltTopic;
  subtopics: PrebuiltSubtopic[];
  questions: QuestionData[];
};

const typedSeedData = seedData as PrebuiltSeedData;

export const prebuiltTopic = typedSeedData.topic;
export const prebuiltSubtopics = typedSeedData.subtopics;
export const prebuiltQuestions = typedSeedData.questions;
