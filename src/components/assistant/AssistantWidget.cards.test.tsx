// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CoachActionView } from "@/lib/assistant/coach-types";

const { cards } = vi.hoisted(() => ({ cards: [] as CoachActionView[] }));
vi.mock("./assistant-context", () => ({
  useAssistant: () => ({
    config: { available: true, audience: "student", greeting: "Hi" },
    open: true,
    setOpen: vi.fn(),
  }),
}));
vi.mock("./use-assistant-conversation", () => ({
  useAssistantConversation: () => ({
    bubbles: [{ role: "assistant", content: "Try this.", cards }],
    activity: [],
    attachments: [],
    send: vi.fn(),
  }),
}));
vi.mock("./AssistantComposer", () => ({ AssistantComposer: () => null }));
import { AssistantWidget } from "./AssistantWidget";

describe("widget recommendation cards", () => {
  it("passes renderCards to the transcript and renders material, simulation and practice cards", () => {
    cards.push(
      {
        kind: "material",
        reason: "Review the basics",
        recommendation: {
          materialTitle: "Arithmetic notes",
          pageRange: { start: 1, end: 2 },
          reason: "Addition",
          pages: [{ pageNumber: 1, imageUrl: "https://signed.test/page.png" }],
        },
      },
      {
        kind: "simulation",
        simulation: {
          simulationId: "sim",
          title: "Number line",
          topic: "Addition",
          learningGoal: "Explore sums",
          version: 1,
        },
        goal: "Explore addition",
        steps: ["Move the slider", "Compare the result"],
        observe: "Watch the marker",
      },
      {
        kind: "practice",
        reason: "Practice your method",
        target: { attemptId: "result", questionNumber: 1 },
        question: {
          versionId: "v",
          questionId: "q",
          text: "What is $3+3$?",
          answerMode: "SINGLE_SELECT",
          answerUnit: null,
          options: [
            { id: "a", text: "6" },
            { id: "b", text: "7" },
          ],
        },
      },
    );
    const html = renderToStaticMarkup(<AssistantWidget />);
    expect(html).toContain("Arithmetic notes");
    expect(html).toContain("Review the basics");
    expect(html).toContain("Number line");
    expect(html).toContain("Open simulation");
    expect(html).toContain("Watch the marker");
    expect(html).toContain("Practice your method");
    expect(html).toContain("Check my answer");
    expect(html).toContain('value="a"');
    expect(html).not.toContain("Correct!");
  });
});
