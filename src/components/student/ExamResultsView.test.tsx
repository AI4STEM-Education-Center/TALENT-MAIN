// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESULT_STATUS,
  type PresignedRecommendation,
  type SimulationRecommendationView,
  type StudentMistakeView,
} from "@/lib/exam-results";

const { assistant, simTelemetry, workspaces } = vi.hoisted(() => ({
  assistant: { available: true },
  simTelemetry: [] as unknown[],
  workspaces: [] as unknown[],
}));

vi.mock("@/components/assistant/assistant-context", () => ({
  useOptionalAssistant: () => ({
    config: { available: assistant.available, audience: "student" },
  }),
}));
vi.mock("@/components/student/coach/WrongAnswerCoach", () => ({
  CoachWorkspace: ({
    target,
    onEngaged,
  }: {
    target: { attemptId: string; questionNumber: number };
    onEngaged?: (engaged: boolean) => void;
  }) => {
    workspaces.push(target);
    return (
      <div data-testid="workspace">
        Coach for question {target.questionNumber}
        <button type="button" onClick={() => onEngaged?.(true)}>
          Send my thoughts
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/simulation/SimulationDialog", () => ({
  SimulationDialog: ({
    simulation,
    onClose,
    telemetry,
  }: {
    simulation: { title: string };
    onClose: () => void;
    telemetry?: unknown;
  }) => {
    simTelemetry.push(telemetry);
    return (
      <div role="dialog">
        {simulation.title}
        <button type="button" onClick={onClose}>
          Close simulation
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/feedback/FeedbackRatingForm", () => ({
  FeedbackRatingForm: () => null,
}));
vi.mock("@/components/student/use-resource-telemetry", () => ({
  useResourceTelemetry: () => ({ containerRef: () => {}, viewPage: () => {} }),
}));
vi.mock("@/components/session-recorder/use-replay-area", () => ({
  useReplayArea: () => {},
}));

import { ExamResultsView } from "./ExamResultsView";

const mistake = (questionNumber: number): StudentMistakeView => ({
  questionNumber,
  text: `Missed question ${questionNumber}`,
  figureUrl: null,
  figureAlt: null,
  response: {
    kind: "choices",
    choices: [{ text: "Wrong pick", imageUrl: null, imageAlt: null }],
  },
});
const simulations: SimulationRecommendationView[] = [
  {
    simulationId: "sim-1",
    title: "Pendulum lab",
    topic: null,
    learningGoal: "Period and length",
  },
];
const recommendations: PresignedRecommendation[] = [
  {
    materialId: "mat-1",
    materialTitle: "Oscillations notes",
    pageRange: { start: 2, end: 3 },
    reason: "Simple harmonic motion",
    pages: [{ pageNumber: 2, imageUrl: "https://signed.test/2.png" }],
  },
];

type Initial = Parameters<typeof ExamResultsView>[0]["initial"];
const ready = (overrides: Partial<Initial> = {}): Initial => ({
  summary: "You did well on kinematics.",
  summaryStatus: RESULT_STATUS.READY,
  summaryMetrics: null,
  recommendations,
  simulations,
  recommendationsStatus: RESULT_STATUS.READY,
  recommendationMetrics: null,
  truncated: false,
  ...overrides,
});

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  assistant.available = true;
  simTelemetry.length = 0;
  workspaces.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      // The live results stream stays open (never resolves) in these tests.
      String(url).includes("/results?stream=1")
        ? new Promise<Response>(() => {})
        : Promise.resolve(Response.json({ feedback: [] })),
    ),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render(
  props: Partial<Parameters<typeof ExamResultsView>[0]> = {},
) {
  await act(async () =>
    root.render(
      <ExamResultsView
        attemptId="att-1"
        score={60}
        mistakes={[mistake(3), mistake(5)]}
        initial={ready()}
        backHref="/student/classes/c1"
        backLabel="Back to class"
        simulationSurface="quiz_results"
        actions={<a href="/retake">Retake quiz</a>}
        {...props}
      />,
    ),
  );
}

const button = (label: RegExp) =>
  [...host.querySelectorAll("button")].find((b) =>
    label.test(`${b.textContent} ${b.getAttribute("aria-label") ?? ""}`),
  ) as HTMLButtonElement | undefined;
const click = async (label: RegExp) => {
  const target = button(label);
  if (!target) throw new Error(`No button ${label}`);
  await act(async () => target.click());
};
const exitNav = () =>
  host.querySelector('nav[aria-label="Leave the guided review"]');
const currentStep = () =>
  host.querySelector('[aria-current="step"]')?.getAttribute("aria-label");

describe("ExamResultsView guided review", () => {
  it("walks Summary → each missed question → simulations → materials → complete", async () => {
    await render();

    // Step 1: summary, with an overview of what is ahead.
    expect(currentStep()).toBe("Summary");
    expect(host.textContent).toContain("You did well on kinematics.");
    expect(host.textContent).toContain("2 questions to talk through");
    expect(host.textContent).toContain("1 interactive simulation to explore");
    expect(host.textContent).not.toContain("Missed question 3");
    expect(workspaces).toHaveLength(0);
    // Simulations never auto-open from an earlier step.
    expect(host.querySelector('[role="dialog"]')).toBeNull();

    await click(/next: review missed questions/i);

    // Step 2: one question at a time, coach embedded on the page.
    expect(host.textContent).toContain("Question 1 of 2");
    expect(workspaces.at(-1)).toEqual({
      attemptId: "att-1",
      questionNumber: 3,
    });
    expect(host.textContent).toContain(
      "Share your thoughts with the coach above",
    );
    expect(button(/^next question/i)).toBeUndefined();
    expect(button(/skip this question/i)).toBeDefined();

    await click(/send my thoughts/i);
    expect(host.textContent).not.toContain(
      "Share your thoughts with the coach",
    );
    await click(/^next question/i);

    expect(host.textContent).toContain("Question 2 of 2");
    expect(workspaces.at(-1)).toEqual({
      attemptId: "att-1",
      questionNumber: 5,
    });
    expect(button(/question 3 \(talked through\)/i)).toBeDefined();
    await click(/send my thoughts/i);
    await click(/continue to simulations/i);

    // Step 3: simulations, launched with full telemetry.
    expect(currentStep()).toBe("Simulations");
    await click(/pendulum lab/i);
    expect(simTelemetry.at(-1)).toEqual({
      attemptId: "att-1",
      surface: "quiz_results",
    });
    await click(/close simulation/i);
    expect(host.textContent).toContain("Explored");
    await click(/continue to learning materials/i);

    // Step 4: materials, with a Viewed mark once opened.
    expect(currentStep()).toBe("Learning materials");
    expect(host.textContent).not.toContain("Viewed");
    await click(/open oscillations notes/i);
    expect(host.textContent).toContain("Viewed");
    await click(/finish review/i);

    // Step 5: what was covered, plus next steps.
    expect(currentStep()).toBe("Complete");
    expect(host.textContent).toContain("Review complete");
    expect(host.textContent).toContain("2/2 missed questions coached");
    expect(host.textContent).toContain("1/1 simulations explored");
    expect(host.textContent).toContain("1/1 materials viewed");
    expect(host.textContent).toContain("Retake quiz");

    await click(/^revisit/i);
    expect(currentStep()).toBe("Summary");
  });

  it("keeps a tiny, quiet Skip to end / Go back home bar on every step", async () => {
    await render();
    for (const next of [
      /next: review missed questions/i,
      /skip this question/i,
      /skip this question/i,
      /continue to learning materials/i,
    ]) {
      const nav = exitNav()!;
      expect(nav.className).toContain("text-[11px]");
      expect(nav.textContent).toContain("Skip to end");
      const home = [...nav.querySelectorAll("a")].find(
        (a) => a.textContent === "Go back home",
      );
      expect(home?.getAttribute("href")).toBe("/student");
      expect(
        [...nav.querySelectorAll("a")].some(
          (a) => a.getAttribute("href") === "/student/classes/c1",
        ),
      ).toBe(true);
      // Plain links: no button chrome.
      for (const el of nav.querySelectorAll("a, button"))
        expect(el.className).not.toMatch(/\bborder\b|\bbg-/);
      await click(next);
    }
    expect(currentStep()).toBe("Learning materials");
    await act(async () =>
      (
        [...exitNav()!.querySelectorAll("button")].find(
          (b) => b.textContent === "Skip to end",
        ) as HTMLButtonElement
      ).click(),
    );
    expect(currentStep()).toBe("Complete");
    expect(exitNav()!.textContent).not.toContain("Skip to end");
    expect(exitNav()!.textContent).toContain("Go back home");
  });

  it("goes straight from the summary to the end when nothing was missed or recommended", async () => {
    await render({
      mistakes: [],
      initial: ready({ simulations: [], recommendations: [] }),
    });
    expect(
      host.querySelectorAll('nav[aria-label="Review progress"] li'),
    ).toHaveLength(2);
    expect(host.textContent).toContain(
      "None — you answered everything correctly",
    );
    await click(/finish review/i);
    expect(host.textContent).toContain("Review complete");
    expect(host.textContent).not.toContain("missed questions coached");
  });

  it("skips past an empty coach step when there are no mistakes", async () => {
    await render({ mistakes: [] });
    await click(/continue to simulations/i);
    expect(currentStep()).toBe("Simulations");
  });

  it("shows the missed question itself when the student assistant is off", async () => {
    assistant.available = false;
    await render();
    await click(/next: review missed questions/i);
    expect(workspaces).toHaveLength(0);
    expect(host.textContent).toContain("Missed question 3");
    expect(host.textContent).toContain("Wrong pick");
    await click(/^next question/i);
    expect(host.textContent).toContain("Missed question 5");
  });

  it("shows a loading state while simulations are still being found", async () => {
    await render({
      initial: ready({
        simulations: [],
        recommendations: [],
        recommendationsStatus: RESULT_STATUS.PENDING,
      }),
    });
    expect(host.textContent).toContain("Finding simulations");
    await click(/skip to end/i);
    expect(currentStep()).toBe("Complete");
  });
});
