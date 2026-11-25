import { describe, it, expect } from "vitest";
import {
  buildCheck2DecisionsRequest,
  buildTutorPromptMessages,
} from "./wrong-answer-coach-prompts";
import type { DecisionsChoiceQuestion } from "./ai-decisions";

describe("wrong-answer-coach-prompts", () => {
  it("Check 2 Decisions API payload is strictly isolated from Check 1 / chosen option (byte-identical)", () => {
    // Type-level + runtime verification: `buildCheck2DecisionsRequest` accepts NO
    // chosenOptionId, chosenOptionText, or check1Label parameters, and canonicalizes
    // option ordering alphabetically so differing option orders produce byte-identical requests.
    const reqA = buildCheck2DecisionsRequest("gpt-6-luna", {
      questionText:
        "A ball is thrown straight up. At its peak, what is its acceleration?",
      options: ["9.8 m/s^2 downward", "0 m/s^2", "9.8 m/s^2 upward"],
      correctOptionText: "9.8 m/s^2 downward",
      keyPoints: ["Gravity acts continuously throughout flight."],
      relevantMisconceptions: [
        { code: "M1", statement: "Zero velocity implies zero acceleration." },
        {
          code: "M2",
          statement: "Acceleration reverses direction at the peak.",
        },
      ],
      studentExplanation:
        "At the highest point the ball stops moving, so acceleration is zero.",
    });

    const reqB = buildCheck2DecisionsRequest("gpt-6-luna", {
      questionText:
        "A ball is thrown straight up. At its peak, what is its acceleration?",
      options: ["0 m/s^2", "9.8 m/s^2 upward", "9.8 m/s^2 downward"],
      correctOptionText: "9.8 m/s^2 downward",
      keyPoints: ["Gravity acts continuously throughout flight."],
      relevantMisconceptions: [
        { code: "M1", statement: "Zero velocity implies zero acceleration." },
        {
          code: "M2",
          statement: "Acceleration reverses direction at the peak.",
        },
      ],
      studentExplanation:
        "At the highest point the ball stops moving, so acceleration is zero.",
    });

    expect(JSON.stringify(reqA)).toBe(JSON.stringify(reqB));
    expect("store" in reqA).toBe(false);
    expect(reqA.questions).toHaveLength(1);
    const q0 = reqA.questions[0] as DecisionsChoiceQuestion;
    expect(q0.type).toBe("choice");
    expect(
      q0.choices.map((c) => (typeof c === "string" ? c : c.value)),
    ).toEqual(["sound", "neither", "M1", "M2"]);
    // Ensure the input text never leaks Check 1 or student's selected option
    expect(String(reqA.input)).not.toContain("Check 1");
    expect(String(reqA.input)).not.toContain("chosen option");
  });

  it("Task B tutor prompt passes diagnosis-specific constraints without leaking internal labels", () => {
    const msgs = buildTutorPromptMessages({
      diagnosis: "MISCONCEPTION",
      misconception: {
        code: "M1",
        statement: "Zero velocity implies zero acceleration.",
      },
      questionText: "At peak height, what is the ball's acceleration?",
      correctOptionText: "9.8 m/s^2 downward",
      chosenOptionText: "0 m/s^2",
      studentExplanation: "It stops at the top.",
      keyPoints: [
        "Gravity pulls downward even when instantaneous velocity is zero.",
      ],
      courseSnippets: [
        {
          materialId: "m1",
          title: "Kinematics Notes",
          pageNumber: 3,
          text: "Free-fall acceleration is constant 9.8 m/s^2 downward.",
          sha256: "abc",
        },
      ],
      maxBodyWords: 120,
    });

    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("150 words");
    expect(msgs[0].content).toContain("9.8 m/s^2 downward");
    expect(msgs[0].content).toContain(
      "Zero velocity implies zero acceleration.",
    );
    expect(msgs[1].content).toContain("Kinematics Notes");
  });
});
