import { describe, it, expect } from "vitest";
import {
  normalizeSelectedOptionIds,
  normalizeNumericValue,
  numericTolerance,
  isNumericAnswerCorrect,
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

const numeric: ScorableQuestion = {
  id: "q3",
  answerMode: "NUMERIC",
  options: [],
  answerNumeric: 42,
  answerTolerance: null,
};

describe("normalizeNumericValue", () => {
  it("passes through a finite number", () => {
    expect(normalizeNumericValue(3.21)).toBe(3.21);
  });

  it("parses a numeric string", () => {
    expect(normalizeNumericValue("3.21")).toBe(3.21);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(normalizeNumericValue(" -769.23 ")).toBe(-769.23);
  });

  it('rejects an empty string (Number("") is 0)', () => {
    expect(normalizeNumericValue("")).toBeNull();
  });

  it("rejects a whitespace-only string", () => {
    expect(normalizeNumericValue("   ")).toBeNull();
  });

  it("rejects a non-numeric string", () => {
    expect(normalizeNumericValue("abc")).toBeNull();
  });

  it("rejects NaN", () => {
    expect(normalizeNumericValue(NaN)).toBeNull();
  });

  it("rejects Infinity", () => {
    expect(normalizeNumericValue(Infinity)).toBeNull();
    expect(normalizeNumericValue(-Infinity)).toBeNull();
  });

  it("rejects null and undefined", () => {
    expect(normalizeNumericValue(null)).toBeNull();
    expect(normalizeNumericValue(undefined)).toBeNull();
  });

  it("rejects booleans", () => {
    expect(normalizeNumericValue(true)).toBeNull();
    expect(normalizeNumericValue(false)).toBeNull();
  });

  it("rejects objects and arrays", () => {
    expect(normalizeNumericValue({})).toBeNull();
    expect(normalizeNumericValue([1])).toBeNull();
  });

  it("parses exponent notation per Number() semantics", () => {
    expect(normalizeNumericValue("1e3")).toBe(1000);
  });

  it("keeps 0 as 0 (not null)", () => {
    expect(normalizeNumericValue(0)).toBe(0);
    expect(normalizeNumericValue("0")).toBe(0);
  });
});

describe("numericTolerance", () => {
  it("uses the stored tolerance when it is a positive finite number", () => {
    expect(numericTolerance(100, 2.5)).toBe(2.5);
  });

  it("falls back to the absolute floor for small answers", () => {
    // max(0.01, 0.005 * 3.21) = max(0.01, 0.01605) = 0.01605
    expect(numericTolerance(3.21)).toBeCloseTo(0.01605, 10);
  });

  it("uses the relative tolerance for large answers", () => {
    // max(0.01, 0.005 * 769.23) = 3.84615
    expect(numericTolerance(769.23)).toBeCloseTo(3.84615, 10);
  });

  it("uses the magnitude of a negative correct answer", () => {
    expect(numericTolerance(-769.23)).toBeCloseTo(3.84615, 10);
  });

  it("falls back to the default when stored is 0, negative, or NaN", () => {
    expect(numericTolerance(769.23, 0)).toBeCloseTo(3.84615, 10);
    expect(numericTolerance(769.23, -1)).toBeCloseTo(3.84615, 10);
    expect(numericTolerance(769.23, NaN)).toBeCloseTo(3.84615, 10);
  });
});

describe("isNumericAnswerCorrect", () => {
  it("is correct for an exact match", () => {
    expect(isNumericAnswerCorrect(numeric, 42)).toBe(true);
  });

  it("is correct within the default tolerance", () => {
    // tolerance = max(0.01, 0.005*42) = 0.21; 42.2 is within.
    expect(isNumericAnswerCorrect(numeric, 42.2)).toBe(true);
  });

  it("is correct exactly at the tolerance boundary (inclusive)", () => {
    // Use binary-exact values: answer 10 with stored tolerance 0.5, so
    // 10.5 lies precisely on the inclusive boundary.
    const boundary: ScorableQuestion = {
      id: "qb",
      answerMode: "NUMERIC",
      options: [],
      answerNumeric: 10,
      answerTolerance: 0.5,
    };
    expect(isNumericAnswerCorrect(boundary, 10.5)).toBe(true);
    expect(isNumericAnswerCorrect(boundary, 9.5)).toBe(true);
  });

  it("is incorrect just outside the tolerance", () => {
    const boundary: ScorableQuestion = {
      id: "qb",
      answerMode: "NUMERIC",
      options: [],
      answerNumeric: 10,
      answerTolerance: 0.5,
    };
    expect(isNumericAnswerCorrect(boundary, 10.6)).toBe(false);
  });

  it("is incorrect when no value was submitted", () => {
    expect(isNumericAnswerCorrect(numeric, null)).toBe(false);
  });

  it("is incorrect when the question lacks a finite answerNumeric", () => {
    const noAnswer: ScorableQuestion = {
      id: "q",
      answerMode: "NUMERIC",
      options: [],
    };
    expect(isNumericAnswerCorrect(noAnswer, 42)).toBe(false);
  });

  it("honors a stored tolerance override", () => {
    const wide: ScorableQuestion = {
      id: "q",
      answerMode: "NUMERIC",
      options: [],
      answerNumeric: 42,
      answerTolerance: 5,
    };
    expect(isNumericAnswerCorrect(wide, 46)).toBe(true);
    expect(isNumericAnswerCorrect(wide, 48)).toBe(false);
  });
});

describe("normalizeSelectedOptionIds", () => {
  it("uses selectedOptionIds when present", () => {
    expect(
      normalizeSelectedOptionIds({
        questionId: "q",
        selectedOptionIds: ["a", "b"],
      }),
    ).toEqual(["a", "b"]);
  });

  it("filters out non-string entries", () => {
    expect(
      normalizeSelectedOptionIds({
        questionId: "q",
        selectedOptionIds: ["a", 1, null, "b"] as unknown[],
      }),
    ).toEqual(["a", "b"]);
  });

  it("wraps a single selectedOptionId", () => {
    expect(
      normalizeSelectedOptionIds({ questionId: "q", selectedOptionId: "a" }),
    ).toEqual(["a"]);
  });

  it("returns [] when nothing is selected", () => {
    expect(normalizeSelectedOptionIds({ questionId: "q" })).toEqual([]);
  });

  it("prefers the array form even when a scalar is also present", () => {
    expect(
      normalizeSelectedOptionIds({
        questionId: "q",
        selectedOptionIds: ["a"],
        selectedOptionId: "b",
      }),
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
    expect(result.answerRecords.every((r) => r.quizAttemptId === "att1")).toBe(
      true,
    );
  });

  it("sets numericValue to null on choice records", () => {
    const result = scoreQuiz({
      attemptId: "att1",
      questionsById,
      answers: [
        { questionId: "q1", selectedOptionId: "a" },
        { questionId: "q2", selectedOptionIds: ["x", "y"] },
      ],
    });
    expect(result.answerRecords.every((r) => r.numericValue === null)).toBe(
      true,
    );
  });

  it("throws when an answered question is missing from the lookup", () => {
    expect(() =>
      scoreQuiz({
        attemptId: "att1",
        questionsById,
        answers: [{ questionId: "ghost", selectedOptionId: "a" }],
      }),
    ).toThrow(/Question not found/);
  });
});

describe("scoreQuiz — numeric and mixed", () => {
  const mixedById = new Map<string, ScorableQuestion>([
    [single.id, single],
    [multi.id, multi],
    [numeric.id, numeric],
  ]);

  it("grades a mixed quiz and persists numericValue on numeric records only", () => {
    const result = scoreQuiz({
      attemptId: "att1",
      questionsById: mixedById,
      answers: [
        { questionId: "q1", selectedOptionId: "b" }, // single, correct
        { questionId: "q2", selectedOptionIds: ["x"] }, // multi, incorrect (partial)
        { questionId: "q3", numericValue: "42" }, // numeric, correct
      ],
    });

    const singleRec = result.answerRecords.find((r) => r.questionId === "q1")!;
    const multiRec = result.answerRecords.find((r) => r.questionId === "q2")!;
    const numericRec = result.answerRecords.find((r) => r.questionId === "q3")!;

    expect(singleRec.isCorrect).toBe(true);
    expect(multiRec.isCorrect).toBe(false);
    expect(numericRec.isCorrect).toBe(true);

    // Numeric record shape: parsed value persisted, no option selection.
    expect(numericRec.numericValue).toBe(42);
    expect(numericRec.selectedOptionId).toBeNull();
    expect(numericRec.selectedOptionIds).toEqual([]);

    // Choice records carry no numeric value.
    expect(singleRec.numericValue).toBeNull();
    expect(multiRec.numericValue).toBeNull();

    expect(result.correct).toBe(2);
    expect(result.total).toBe(3);
  });

  it("marks a numeric answer outside tolerance as incorrect but still persists the value", () => {
    const result = scoreQuiz({
      attemptId: "att1",
      questionsById: mixedById,
      answers: [{ questionId: "q3", numericValue: 100 }],
    });
    const rec = result.answerRecords[0];
    expect(rec.isCorrect).toBe(false);
    expect(rec.numericValue).toBe(100);
    expect(result.correct).toBe(0);
  });

  it("treats a blank numeric submission as incorrect with null numericValue", () => {
    const result = scoreQuiz({
      attemptId: "att1",
      questionsById: mixedById,
      answers: [{ questionId: "q3", numericValue: "" }],
    });
    const rec = result.answerRecords[0];
    expect(rec.isCorrect).toBe(false);
    expect(rec.numericValue).toBeNull();
    expect(result.correct).toBe(0);
  });

  it("regression: a true/false-style single-select scores unchanged", () => {
    const trueFalse: ScorableQuestion = {
      id: "tf",
      answerMode: "SINGLE_SELECT",
      options: [
        { id: "true", isCorrect: true },
        { id: "false", isCorrect: false },
      ],
    };
    const result = scoreQuiz({
      attemptId: "att1",
      questionsById: new Map([[trueFalse.id, trueFalse]]),
      answers: [{ questionId: "tf", selectedOptionId: "true" }],
    });
    const rec = result.answerRecords[0];
    expect(rec.isCorrect).toBe(true);
    expect(rec.selectedOptionId).toBe("true");
    expect(rec.selectedOptionIds).toEqual(["true"]);
    expect(rec.numericValue).toBeNull();
    expect(result.score).toBe(100);
  });
});
