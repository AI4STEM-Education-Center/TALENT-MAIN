import { describe, it, expect } from "vitest";
import { buildQuizReviewPrompt, type QuizReviewAttempt } from "./chat-prompt";

function makeAttempt(
  overrides: Partial<QuizReviewAttempt> = {},
): QuizReviewAttempt {
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
          question: {
            text: "Q",
            options: [{ text: "Vector", isCorrect: true }],
          },
        },
      ],
    });
    const prompt = buildQuizReviewPrompt(attempt);
    expect(prompt).toContain("The student answered every question correctly.");
    expect(prompt).not.toContain("Evidence from incorrect answers:");
  });

  it("renders defaults for a null score and missing completion timestamp", () => {
    const prompt = buildQuizReviewPrompt(
      makeAttempt({ score: null, completedAt: null }),
    );
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

  it("emits NUMERIC evidence lines with the student's and correct value (+unit)", () => {
    const attempt = makeAttempt({
      answers: [
        {
          isCorrect: false,
          selectedOption: null,
          numericValue: 8,
          question: {
            text: "Acceleration of gravity?",
            options: [],
            answerMode: "NUMERIC",
            answerNumeric: 9.8,
            answerUnit: "m/s^2",
          },
        },
      ],
    });
    const prompt = buildQuizReviewPrompt(attempt);
    // NUMERIC questions use "Student answer:" (not "Student selection:").
    expect(prompt).toContain("1. Question: Acceleration of gravity?");
    expect(prompt).toContain("Student answer: 8 m/s^2");
    expect(prompt).toContain("Correct answer: 9.8 m/s^2");
    expect(prompt).not.toContain("Student selection:");
  });

  it("uses 'No answer' for a blank NUMERIC submission", () => {
    const attempt = makeAttempt({
      answers: [
        {
          isCorrect: false,
          selectedOption: null,
          numericValue: null,
          question: {
            text: "Mass in kg?",
            options: [],
            answerMode: "NUMERIC",
            answerNumeric: 5,
            answerUnit: null,
          },
        },
      ],
    });
    const prompt = buildQuizReviewPrompt(attempt);
    expect(prompt).toContain("Student answer: No answer");
    // No unit was set, so nothing is appended.
    expect(prompt).toContain("Correct answer: 5");
  });

  it("passes $...$ LaTeX through raw in NUMERIC question text and unit", () => {
    const attempt = makeAttempt({
      answers: [
        {
          isCorrect: false,
          selectedOption: null,
          numericValue: 0.3,
          question: {
            text: "Find the static friction coefficient $\\mu_s$.",
            options: [],
            answerMode: "NUMERIC",
            answerNumeric: 0.4,
            answerUnit: "$\\text{dimensionless}$",
          },
        },
      ],
    });
    const prompt = buildQuizReviewPrompt(attempt);
    expect(prompt).toContain("$\\mu_s$");
    expect(prompt).toContain("Student answer: 0.3 $\\text{dimensionless}$");
    expect(prompt).toContain("Correct answer: 0.4 $\\text{dimensionless}$");
  });

  it("keeps choice evidence byte-identical when a NUMERIC answer is also present", () => {
    // Mixed attempt: one choice (wrong), one numeric (wrong). The choice lines
    // must remain exactly as before (option-based, "Student selection:").
    const attempt = makeAttempt({
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
          isCorrect: false,
          selectedOption: null,
          numericValue: 3,
          question: {
            text: "Value of pi (1 dp)?",
            options: [],
            answerMode: "NUMERIC",
            answerNumeric: 3.1,
            answerUnit: null,
          },
        },
      ],
    });
    const prompt = buildQuizReviewPrompt(attempt);
    expect(prompt).toContain("1. Question: Units of acceleration?");
    expect(prompt).toContain("Student selection: 9.8 m/s");
    expect(prompt).toContain("Correct answer: m/s^2");
    expect(prompt).toContain("2. Question: Value of pi (1 dp)?");
    expect(prompt).toContain("Student answer: 3");
    expect(prompt).toContain("Correct answer: 3.1");
  });
});
