// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminSimulationsClient } from "./simulations-client";

vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));
vi.mock("@/components/simulation/SimulationPanel", () => ({
  SimulationPanel: ({
    simulationId,
    canGiveFeedback,
    onOpenChange,
  }: {
    simulationId: string;
    canGiveFeedback: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div role="dialog" aria-label="Simulation editor">
      {canGiveFeedback ? `Editing ${simulationId}` : "Read only"}
      <button onClick={() => onOpenChange(false)}>Close editor</button>
    </div>
  ),
}));

const counts = { ready: 1, missing: 1, failed: 1, declined: 0, inFlight: 0 };
const summary = {
  quizzes: [
    {
      id: "teacher-quiz",
      name: "Teacher quiz",
      topicName: "Waves",
      teacher: {
        firstName: "Tess",
        lastName: "Teacher",
        email: "teacher@example.com",
      },
      questionCount: 3,
      counts,
    },
  ],
  totals: counts,
};
const detail = {
  quiz: { id: "teacher-quiz", name: "Teacher quiz" },
  questions: [
    { id: "missing", text: "Missing question", simulation: null },
    {
      id: "failed",
      text: "Failed question",
      simulation: {
        id: "failed-sim",
        status: "FAILED",
        hasContent: false,
        feedbackCount: 0,
        aiMetrics: {},
      },
    },
    {
      id: "ready",
      text: "Ready question",
      simulation: {
        id: "ready-sim",
        status: "READY",
        hasContent: true,
        version: 1,
        feedbackCount: 0,
        aiMetrics: {},
      },
    },
  ],
};
const fetchMock = vi.fn();
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock
    .mockReset()
    .mockImplementation(async (url: string, options?: RequestInit) => ({
      ok: true,
      json: async () =>
        options?.method === "POST"
          ? { created: 1, retried: 1, skipped: 1 }
          : url.includes("?quizId=")
            ? detail
            : summary,
    }));
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<AdminSimulationsClient />));
}
function button(text: string) {
  const found = [...host.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function expand() {
  const toggle = host.querySelector<HTMLButtonElement>(
    "button[aria-expanded]",
  )!;
  await act(async () => toggle.click());
}
function lastPayload() {
  const calls = fetchMock.mock.calls.filter(
    ([, options]) => options?.method === "POST",
  );
  expect(calls.at(-1)?.[0]).toBe("/api/admin/simulations/generate");
  return JSON.parse(calls.at(-1)![1].body);
}

it("enables bulk generation when only teacher quizzes have missing or failed simulations", async () => {
  await render();
  expect(button("Generate missing (2)").disabled).toBe(false);
  await click("Generate missing (2)");
  expect(lastPayload()).toEqual({ scope: "all" });
});

it("provides quiz generation, question generation, retry and regeneration for teacher quizzes", async () => {
  await render();
  await click("Generate (2)");
  expect(lastPayload()).toEqual({ scope: "quiz", quizId: "teacher-quiz" });
  await expand();
  await click("Generate");
  expect(lastPayload()).toEqual({ scope: "question", questionId: "missing" });
  await click("Retry");
  expect(lastPayload()).toEqual({ scope: "question", questionId: "failed" });
  await click("Regenerate");
  expect(lastPayload()).toEqual({
    scope: "question",
    questionId: "ready",
    force: true,
  });
});

it("opens an editable simulation panel and refreshes the quiz when it closes", async () => {
  await render();
  await expand();
  await click("View / edit");
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
    "Editing ready-sim",
  );
  fetchMock.mockClear();
  await click("Close editor");
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith("/api/admin/simulations");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/admin/simulations?quizId=teacher-quiz",
  );
});

it("shows a network error and re-enables generation for a retry", async () => {
  await render();
  fetchMock.mockRejectedValueOnce(new Error("offline"));
  await click("Generate missing (2)");
  expect(host.textContent).toContain(
    "Failed to start generation. Please try again.",
  );
  expect(button("Generate missing (2)").disabled).toBe(false);
});
