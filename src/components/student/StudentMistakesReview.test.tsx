import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudentMistakesReview } from "./StudentMistakesReview";

describe("StudentMistakesReview", () => {
  it("renders missed prompts and submitted choices without answer-key content", () => {
    const html = renderToStaticMarkup(
      <StudentMistakesReview
        mistakes={[
          {
            questionNumber: 4,
            text: "Which city did you choose?",
            figureUrl: "https://example.test/question.png",
            figureAlt: "Map",
            response: {
              kind: "choices",
              choices: [
                {
                  text: "Rome",
                  imageUrl: "https://example.test/rome.png",
                  imageAlt: "Rome skyline",
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(html).toContain("Questions to review");
    expect(html).toContain("4.");
    expect(html).toContain("Which city did you choose?");
    expect(html).toContain("Your answer");
    expect(html).toContain("Rome");
    expect(html).toContain("Rome skyline");
    expect(html).not.toContain("Paris");
    expect(html).not.toContain("Correct answer");
    expect(html).not.toContain("Teacher-only");
  });

  it("preserves a numeric zero with its unit and renders legacy no-answer cases", () => {
    const html = renderToStaticMarkup(
      <StudentMistakesReview
        mistakes={[
          {
            questionNumber: 2,
            text: "Enter a displacement",
            figureUrl: null,
            figureAlt: null,
            response: { kind: "numeric", value: 0, unit: "m" },
          },
          {
            questionNumber: 5,
            text: "Pick one",
            figureUrl: null,
            figureAlt: null,
            response: { kind: "choices", choices: [] },
          },
        ]}
      />,
    );

    expect(html).toContain("0 m");
    expect(html).toContain("No answer");
  });

  it("renders no review section for a perfect attempt", () => {
    expect(renderToStaticMarkup(<StudentMistakesReview mistakes={[]} />)).toBe(
      "",
    );
  });
});
