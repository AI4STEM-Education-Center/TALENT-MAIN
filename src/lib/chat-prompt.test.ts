import { describe, it, expect } from "vitest";
import { isChatMessageArray, buildQuizReviewPrompt, type QuizReviewAttempt } from "./chat-prompt";

describe("isChatMessageArray", () => {
  it("accepts a well-formed message array", () => {
    expect(
      isChatMessageArray([
        { role: "system", content: "hi" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hey" },
      ])
    ).toBe(true);
  });

  it("accepts an empty array", () => {
    expect(isChatMessageArray([])).toBe(true);
  });

  it("rejects non-arrays", () => {
    expect(isChatMessageArray(null)).toBe(false);
    expect(isChatMessageArray({ role: "user", content: "x" })).toBe(false);
    expect(isChatMessageArray("hello")).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(isChatMessageArray([{ role: "robot", content: "x" }])).toBe(false);
  });

  it("rejects non-string content", () => {
    expect(isChatMessageArray([{ role: "user", content: 42 }])).toBe(false);
  });

  it("rejects null/primitive entries", () => {
    expect(isChatMessageArray([null])).toBe(false);
    expect(isChatMessageArray(["just a string"])).toBe(false);
  });
});

function makeAttempt(overrides: Partial<QuizReviewAttempt> = {}): QuizReviewAttempt {
  return {
    score: 50,
    completedAt: new Date("2026-03-01T12:00:00.000Z"),
    class: { name: "Physics 101" },
    quiz: { name: "Kinematics", topic: { name: "Mechanics" } },
    answers: [
      {
        isCorrect: false,
        selectedOption: { text: "9.8 m/s" },
        question: {
          text: "Units of acceleration?",
          options: [
            { text: "9.8 m/s", isCorrect: false },
            { text: "m/s^2", isCorrect: true },
          ],
        },
      },
      {
        isCorrect: true,
        selectedOption: { text: "Vector" },
        question: {
          text: "Is velocity a vector?",
          options: [{ text: "Vector", isCorrect: true }],
        },
      },
    ],
    ...overrides,
  };
}

describe("buildQuizReviewPrompt", () => {
  it("includes class, topic, quiz and score metadata", () => {
    const prompt = buildQuizReviewPrompt(makeAttempt());
    expect(prompt).toContain("Class: Physics 101");
    expect(prompt).toContain("Topic: Mechanics");
    expect(prompt).toContain("Quiz: Kinematics");
    expect(prompt).toContain("Score: 50%");
    expect(prompt).toContain("Completed at: 2026-03-01T12:00:00.000Z");
    expect(prompt).toContain("Questions answered: 2");
    expect(prompt).toContain("Correct answers: 1");
    expect(prompt).toContain("Incorrect answers: 1");
  });

  it("lists evidence only for incorrect answers, with the correct answer", () => {
    const prompt = buildQuizReviewPrompt(makeAttempt());
    expect(prompt).toContain("Evidence from incorrect answers:");
    expect(prompt).toContain("1. Question: Units of acceleration?");
    expect(prompt).toContain("Student selection: 9.8 m/s");
    expect(prompt).toContain("Correct answer: m/s^2");
    // The correct answer's question text should not appear as evidence.
    expect(prompt).not.toContain("Is velocity a vector?");
  });

  it("uses the all-correct branch when nothing was wrong", () => {
    const attempt = makeAttempt({
      score: 100,
      answers: [
        {
          isCorrect: true,
          selectedOption: { text: "Vector" },
          question: { text: "Q", options: [{ text: "Vector", isCorrect: true }] },
        },
      ],
    });
    const prompt = buildQuizReviewPrompt(attempt);
    expect(prompt).toContain("The student answered every question correctly.");
    expect(prompt).not.toContain("Evidence from incorrect answers:");
  });

  it("renders defaults for a null score and missing completion timestamp", () => {
    const prompt = buildQuizReviewPrompt(makeAttempt({ score: null, completedAt: null }));
    expect(prompt).toContain("Score: 0%");
    expect(prompt).toContain("Completed at: Unknown");
  });

  it("shows 'No answer selected' and 'Unknown' when data is absent", () => {
    const attempt = makeAttempt({
      answers: [
        {
          isCorrect: false,
          selectedOption: null,
          question: {
            text: "Mystery question",
            options: [{ text: "only wrong", isCorrect: false }],
          },
        },
      ],
    });
    const prompt = buildQuizReviewPrompt(attempt);
    expect(prompt).toContain("Student selection: No answer selected");
    expect(prompt).toContain("Correct answer: Unknown");
  });
});
