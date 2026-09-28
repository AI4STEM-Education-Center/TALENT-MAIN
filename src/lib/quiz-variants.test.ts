import { describe, it, expect } from "vitest";
import {
  validateVariant,
  validateVerification,
  scoreVariant,
  studentVariantQuestions,
  type VariantQuestion,
} from "./quiz-variants";
const numeric: VariantQuestion = {
  id: "n",
  sourceQuestionId: "source",
  text: "What is 6 divided by 2?",
  answerMode: "NUMERIC",
  answerUnit: null,
  answerNumeric: 3,
  answerTolerance: 0.01,
  options: [],
  solution: "6/2 = 3",
  intentExplanation: "Divide whole numbers.",
};
const choice: VariantQuestion = {
  ...numeric,
  id: "c",
  sourceQuestionId: "choice-source",
  answerMode: "SINGLE_SELECT",
  answerNumeric: null,
  answerTolerance: null,
  options: [
    { id: "a", text: "3", isCorrect: true },
    { id: "b", text: "4", isCorrect: false },
  ],
};
const sources = [numeric, choice].map((q) => ({
  id: q.sourceQuestionId,
  answerMode: q.answerMode,
}));
describe("alternative quiz validation", () => {
  it("preserves coverage, ordering and answer formats", () => {
    expect(validateVariant({ questions: [choice, numeric] }, sources)).toEqual([
      numeric,
      choice,
    ]);
    expect(() =>
      validateVariant({ questions: [numeric, numeric] }, sources),
    ).toThrow();
    expect(() => validateVariant({ questions: [numeric] }, sources)).toThrow();
    expect(() =>
      validateVariant(
        { questions: [{ ...choice, sourceQuestionId: "source" }, numeric] },
        sources,
      ),
    ).toThrow();
  });
  it("rejects ambiguous and malformed keys", () => {
    for (const invalid of [
      { ...numeric, answerNumeric: null },
      { ...numeric, answerNumeric: Infinity },
      { ...numeric, answerTolerance: -1 },
      {
        ...choice,
        options: choice.options.map((o) => ({ ...o, isCorrect: true })),
      },
      {
        ...choice,
        options: choice.options.map((o) => ({ ...o, text: "same" })),
      },
      { ...choice, options: choice.options.map((o) => ({ ...o, id: "same" })) },
    ])
      expect(() =>
        validateVariant({ questions: [invalid] }, [
          { id: invalid.sourceQuestionId, answerMode: invalid.answerMode },
        ]),
      ).toThrow();
  });
  it("requires complete, independent agreement on intent and answers", () => {
    const review = {
      sourceQuestionId: "source",
      intentPreserved: true,
      unambiguous: true,
      answerNumeric: 3,
      correctOptionId: null,
      explanation: "6/2 = 3",
    };
    expect(validateVerification({ reviews: [review] }, [numeric])).toHaveLength(
      1,
    );
    for (const changed of [
      { answerNumeric: 4 },
      { intentPreserved: false },
      { unambiguous: false },
      { sourceQuestionId: "other" },
    ])
      expect(() =>
        validateVerification({ reviews: [{ ...review, ...changed }] }, [
          numeric,
        ]),
      ).toThrow();
  });
  it("never sends grading or generation data to students", () => {
    const payload = studentVariantQuestions([numeric, choice], "attempt");
    expect(payload[0]).toEqual({
      id: "n",
      text: numeric.text,
      answerMode: "NUMERIC",
      answerUnit: null,
      options: [],
    });
    expect(Object.keys(payload[1].options[0]).sort()).toEqual(["id", "text"]);
    expect(studentVariantQuestions([choice], "same")).toEqual(
      studentVariantQuestions([choice], "same"),
    );
  });
  it("counts omissions as incorrect and rejects duplicate/foreign answers", () => {
    expect(
      scoreVariant(
        [numeric, choice],
        [{ questionId: "n", numericValue: 3 }],
        "a",
      ).score,
    ).toBe(50);
    expect(() =>
      scoreVariant([numeric], [{ questionId: "n" }, { questionId: "n" }], "a"),
    ).toThrow();
    expect(() =>
      scoreVariant([numeric], [{ questionId: "other" }], "a"),
    ).toThrow();
    expect(() =>
      scoreVariant(
        [choice],
        [{ questionId: "c", selectedOptionIds: ["foreign"] }],
        "a",
      ),
    ).toThrow();
    expect(() =>
      scoreVariant(
        [choice],
        [{ questionId: "c", selectedOptionIds: ["a", "b"] }],
        "a",
      ),
    ).toThrow();
  });
});
