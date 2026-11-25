import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StudentMistakeView } from "@/lib/exam-results";

// No assistant provider: the coach is off and the plain missed-question card
// is shown instead of the chat.
vi.mock("@/components/assistant/assistant-context", () => ({
  useOptionalAssistant: () => null,
}));
vi.mock("@/components/student/coach/WrongAnswerCoach", () => ({
  CoachWorkspace: () => <div data-testid="legacy-coach-workspace" />,
}));
vi.mock("@/components/student/WrongAnswerCoachDrawer", () => ({
  WrongAnswerCoachPanel: ({
    questionId,
    questionNumber,
  }: {
    questionId: string;
    questionNumber: number;
  }) => (
    <div data-testid="diagnostic-coach-panel">
      Diagnostic Coach Q{questionNumber} ({questionId})
    </div>
  ),
}));

import { CoachStep } from "./CoachStep";

const render = (
  mistake: StudentMistakeView,
  extra?: Partial<Parameters<typeof CoachStep>[0]>,
) =>
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
      {...extra}
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

  it("embeds the new diagnostic WrongAnswerCoachPanel inline when the question is eligible", () => {
    const html = render(
      {
        questionNumber: 1,
        text: "Which pair is Newton's Third Law?",
        figureUrl: null,
        figureAlt: null,
        response: {
          kind: "choices",
          choices: [
            { text: "Weight and normal", imageUrl: null, imageAlt: null },
          ],
        },
      },
      {
        coachEligibility: {
          1: {
            questionId: "q-newton",
            questionNumber: 1,
            eligible: true,
            sessionId: null,
            sessionStatus: "NOT_STARTED",
          },
        },
      },
    );

    expect(html).toContain("Diagnostic Coach Q1 (q-newton)");
    expect(html).not.toContain("legacy-coach-workspace");
    expect(html).toContain("Skip this question");
  });
});
