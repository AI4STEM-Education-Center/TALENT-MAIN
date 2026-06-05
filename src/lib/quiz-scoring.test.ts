import { describe, it, expect } from "vitest";
import {
  normalizeSelectedOptionIds,
  isAnswerCorrect,
  scoreQuiz,
  type ScorableQuestion,
} from "./quiz-scoring";

const single: ScorableQuestion = {
  id: "q1",
  answerMode: "SINGLE_SELECT",
  options: [
    { id: "a", isCorrect: false },
    { id: "b", isCorrect: true },
    { id: "c", isCorrect: false },
  ],
};

const multi: ScorableQuestion = {
  id: "q2",
  answerMode: "MULTI_SELECT",
  options: [
    { id: "x", isCorrect: true },
    { id: "y", isCorrect: true },
    { id: "z", isCorrect: false },
  ],
};

describe("normalizeSelectedOptionIds", () => {
  it("uses selectedOptionIds when present", () => {
    expect(normalizeSelectedOptionIds({ questionId: "q", selectedOptionIds: ["a", "b"] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("filters out non-string entries", () => {
    expect(
      normalizeSelectedOptionIds({ questionId: "q", selectedOptionIds: ["a", 1, null, "b"] as unknown[] })
    ).toEqual(["a", "b"]);
  });

  it("wraps a single selectedOptionId", () => {
    expect(normalizeSelectedOptionIds({ questionId: "q", selectedOptionId: "a" })).toEqual(["a"]);
  });

  it("returns [] when nothing is selected", () => {
    expect(normalizeSelectedOptionIds({ questionId: "q" })).toEqual([]);
  });

  it("prefers the array form even when a scalar is also present", () => {
    expect(
      normalizeSelectedOptionIds({ questionId: "q", selectedOptionIds: ["a"], selectedOptionId: "b" })
    ).toEqual(["a"]);
  });
});

describe("isAnswerCorrect — single select", () => {
  it("is correct when the first selection is the correct option", () => {
    expect(isAnswerCorrect(single, ["b"])).toBe(true);
  });

  it("is incorrect for a wrong option", () => {
    expect(isAnswerCorrect(single, ["a"])).toBe(false);
  });

  it("is incorrect when nothing is selected", () => {
    expect(isAnswerCorrect(single, [])).toBe(false);
  });

  it("only considers the first selected id", () => {
    // ["a","b"] -> first is "a" (wrong), so incorrect despite "b" being present.
    expect(isAnswerCorrect(single, ["a", "b"])).toBe(false);
  });
});

describe("isAnswerCorrect — multi select", () => {
  it("requires the exact set of correct options", () => {
    expect(isAnswerCorrect(multi, ["x", "y"])).toBe(true);
  });

  it("rejects a partial selection", () => {
    expect(isAnswerCorrect(multi, ["x"])).toBe(false);
  });

  it("rejects a superset (extra wrong option)", () => {
    expect(isAnswerCorrect(multi, ["x", "y", "z"])).toBe(false);
  });

  it("rejects an empty selection", () => {
    expect(isAnswerCorrect(multi, [])).toBe(false);
  });

  it("ignores selection order", () => {
    expect(isAnswerCorrect(multi, ["y", "x"])).toBe(true);
  });
});

describe("scoreQuiz", () => {
  const questionsById = new Map<string, ScorableQuestion>([
    [single.id, single],
    [multi.id, multi],
  ]);

  it("computes correct count and percentage", () => {
    const result = scoreQuiz({
      attemptId: "att1",
      questionsById,
      answers: [
        { questionId: "q1", selectedOptionId: "b" }, // correct
        { questionId: "q2", selectedOptionIds: ["x"] }, // incorrect (partial)
      ],
    });
    expect(result.correct).toBe(1);
    expect(result.total).toBe(2);
    expect(result.score).toBe(50);
  });

  it("returns score 0 (not NaN) for an empty answer set", () => {
    const result = scoreQuiz({ attemptId: "att1", questionsById, answers: [] });
    expect(result.score).toBe(0);
    expect(result.correct).toBe(0);
    expect(result.total).toBe(0);
  });

  it("scores a perfect attempt as 100", () => {
    const result = scoreQuiz({
      attemptId: "att1",
      questionsById,
      answers: [
        { questionId: "q1", selectedOptionId: "b" },
        { questionId: "q2", selectedOptionIds: ["x", "y"] },
      ],
    });
    expect(result.score).toBe(100);
  });

  it("records selectedOptionId for single-select and null for multi-select", () => {
    const result = scoreQuiz({
      attemptId: "att1",
      questionsById,
      answers: [
        { questionId: "q1", selectedOptionId: "a" },
        { questionId: "q2", selectedOptionIds: ["x", "y"] },
      ],
    });
    const single = result.answerRecords.find((r) => r.questionId === "q1")!;
    const multi = result.answerRecords.find((r) => r.questionId === "q2")!;
    expect(single.selectedOptionId).toBe("a");
    expect(single.selectedOptionIds).toEqual(["a"]);
    expect(multi.selectedOptionId).toBeNull();
    expect(multi.selectedOptionIds).toEqual(["x", "y"]);
    expect(result.answerRecords.every((r) => r.quizAttemptId === "att1")).toBe(true);
  });

  it("throws when an answered question is missing from the lookup", () => {
    expect(() =>
      scoreQuiz({
        attemptId: "att1",
        questionsById,
        answers: [{ questionId: "ghost", selectedOptionId: "a" }],
      })
    ).toThrow(/Question not found/);
  });
});
