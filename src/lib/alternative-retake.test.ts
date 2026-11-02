import { describe, expect, it } from "vitest";
import {
  alternativeNotice,
  excludedCountOf,
  previouslyCorrectQuestionIds,
  selectRetakeQuestions,
  variantAnswerRows,
  variantSnapshotInputs,
} from "./alternative-retake";
import type { VariantQuestion } from "./quiz-variants";

const variant = (id: string, source: string): VariantQuestion => ({
  id,
  sourceQuestionId: source,
  text: id,
  answerMode: "SINGLE_SELECT",
  answerUnit: null,
  answerNumeric: null,
  answerTolerance: null,
  options: [
    { id: `${id}-a`, text: "A", isCorrect: true },
    { id: `${id}-b`, text: "B", isCorrect: false },
  ],
  solution: "s",
  intentExplanation: "i",
});
const questions = [
  variant("v1", "q1"),
  variant("v2", "q2"),
  variant("v3", "q3"),
];
const day = (n: number) => new Date(2026, 0, n);

describe("previouslyCorrectQuestionIds", () => {
  it("uses the most recent result per question, whatever attempt it came from", () => {
    const correct = previouslyCorrectQuestionIds([
      { questionId: "q1", isCorrect: true, completedAt: day(1) },
      { questionId: "q2", isCorrect: false, completedAt: day(1) },
      { questionId: "q2", isCorrect: true, completedAt: day(3) },
      { questionId: "q1", isCorrect: false, completedAt: day(2) },
      { questionId: "q3", isCorrect: true, completedAt: day(2) },
    ]);
    expect([...correct].sort()).toEqual(["q2", "q3"]);
  });
  it("is empty without history", () => {
    expect(previouslyCorrectQuestionIds([]).size).toBe(0);
  });
});

describe("selectRetakeQuestions", () => {
  it("keeps everything unless exclusion is requested", () => {
    const sel = selectRetakeQuestions(questions, new Set(["q1"]), false);
    expect(sel.questions).toHaveLength(3);
    expect(sel.excludedSourceIds).toEqual([]);
  });
  it("drops previously-correct questions and reports them", () => {
    const sel = selectRetakeQuestions(questions, new Set(["q1", "q3"]), true);
    expect(sel.questions.map((q) => q.id)).toEqual(["v2"]);
    expect(sel.excludedSourceIds).toEqual(["q1", "q3"]);
    expect(sel.exclusionIgnored).toBe(false);
  });
  it("asks the full version when nothing would remain", () => {
    const sel = selectRetakeQuestions(
      questions,
      new Set(["q1", "q2", "q3"]),
      true,
    );
    expect(sel.questions).toHaveLength(3);
    expect(sel.excludedSourceIds).toEqual([]);
    expect(sel.exclusionIgnored).toBe(true);
  });
  it("does nothing when no history matches", () => {
    const sel = selectRetakeQuestions(questions, new Set(["other"]), true);
    expect(sel.questions).toHaveLength(3);
    expect(sel.exclusionIgnored).toBe(false);
  });
});

describe("recording helpers", () => {
  const records = [
    {
      quizAttemptId: "x",
      questionId: "v1",
      selectedOptionId: "v1-a",
      selectedOptionIds: ["v1-a"],
      numericValue: null,
      isCorrect: true,
    },
    {
      quizAttemptId: "x",
      questionId: "v2",
      selectedOptionId: null,
      selectedOptionIds: [],
      numericValue: null,
      isCorrect: false,
    },
  ];
  it("files answers under the source question, skipping deleted sources, with no option FK", () => {
    const rows = variantAnswerRows(
      "attempt",
      questions,
      records,
      new Set(["q1"]),
    );
    expect(rows).toEqual([
      {
        quizAttemptId: "attempt",
        questionId: "q1",
        selectedOptionId: null,
        selectedOptionIds: JSON.stringify(["v1-a"]),
        numericValue: null,
        isCorrect: true,
      },
    ]);
  });
  it("builds snapshot inputs keyed by source question id", () => {
    const input = variantSnapshotInputs(questions.slice(0, 2), records);
    expect(input.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(input.answers.map((a) => a.questionId)).toEqual(["q1", "q2"]);
  });
});

describe("labels", () => {
  it("parses stored exclusions defensively", () => {
    expect(excludedCountOf('["a","b"]')).toBe(2);
    expect(excludedCountOf("nope")).toBe(0);
    expect(excludedCountOf(null)).toBe(0);
  });
  it("explains the scope of the score", () => {
    expect(alternativeNotice("Version A", 0)).not.toContain("left out");
    expect(alternativeNotice("Version A", 1)).toContain(
      "1 question you answered correctly before was left out",
    );
    expect(alternativeNotice("Version A", 3)).toContain("3 questions");
  });
});
