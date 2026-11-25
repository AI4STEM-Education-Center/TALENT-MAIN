import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StudentMistakeView } from "@/lib/exam-results";

// No assistant provider: the coach is off and the plain missed-question card
// is shown instead of the chat.
vi.mock("@/components/assistant/assistant-context", () => ({
  useOptionalAssistant: () => null,
}));
vi.mock("@/components/student/coach/WrongAnswerCoach", () => ({
  CoachWorkspace: () => null,
}));

import { CoachStep } from "./CoachStep";

const render = (mistake: StudentMistakeView) =>
  renderToStaticMarkup(
    <CoachStep
      attemptId="att-1"
      mistakes={[mistake]}
      index={0}
      onIndexChange={() => {}}
      engaged={new Set()}
      onEngaged={() => {}}
      nextLabel="Next"
      onFinish={() => {}}
    />,
  );

describe("CoachStep without the assistant", () => {
  it("shows image-only answer choices as images, told apart by their alt text", () => {
    const html = render({
      questionNumber: 2,
      text: "Which graph shows constant speed?",
      figureUrl: null,
      figureAlt: null,
      response: {
        kind: "choices",
        choices: [
          {
            text: "",
            imageUrl: "https://signed.test/a.png",
            imageAlt: "Graph A",
          },
          {
            text: "",
            imageUrl: "https://signed.test/c.png",
            imageAlt: "Graph C",
          },
        ],
      },
    });
    expect(html).toContain('src="https://signed.test/a.png"');
    expect(html).toContain('alt="Graph A"');
    expect(html).toContain('src="https://signed.test/c.png"');
    expect(html).toContain('alt="Graph C"');
  });

  it("shows text and image together when a choice has both", () => {
    const html = render({
      questionNumber: 2,
      text: "Pick one",
      figureUrl: null,
      figureAlt: null,
      response: {
        kind: "choices",
        choices: [
          {
            text: "Graph B",
            imageUrl: "https://signed.test/b.png",
            imageAlt: null,
          },
        ],
      },
    });
    expect(html).toContain('src="https://signed.test/b.png"');
    expect(html).toContain("Graph B");
  });
});
