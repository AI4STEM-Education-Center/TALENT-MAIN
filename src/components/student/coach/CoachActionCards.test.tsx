// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachActionView } from "@/lib/assistant/coach-types";

const { telemetryCalls, simCalls } = vi.hoisted(() => ({
  telemetryCalls: [] as unknown[],
  simCalls: [] as unknown[],
}));
vi.mock("@/components/student/use-resource-telemetry", () => ({
  useResourceTelemetry: (args: unknown) => {
    telemetryCalls.push(args);
    return { containerRef: () => {}, viewPage: () => {} };
  },
}));
vi.mock("@/components/simulation/SimulationDialog", () => ({
  SimulationDialog: (props: { telemetry?: unknown }) => {
    simCalls.push(props.telemetry);
    return <div role="dialog">simulation</div>;
  },
}));
vi.mock("@/components/feedback/FeedbackRatingForm", () => ({
  FeedbackRatingForm: () => null,
}));
vi.mock("@/components/session-recorder/use-replay-area", () => ({
  useReplayArea: () => {},
}));

import { CoachActionCards } from "./CoachActionCards";

let root: Root;
let host: HTMLElement;
let calls: { url: string; body: unknown }[];

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  telemetryCalls.length = 0;
  simCalls.length = 0;
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({
        interaction: { status: "viewed", viewedAt: "2026-11-20T00:00:00Z" },
      });
    }),
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

const flush = () =>
  act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const button = (label: RegExp) =>
  [...document.querySelectorAll("button")].find((b) =>
    label.test(`${b.textContent} ${b.getAttribute("aria-label") ?? ""}`),
  ) as HTMLButtonElement | undefined;

const material: CoachActionView = {
  cardId: "card-m",
  kind: "material",
  reason: "Revisit orbits",
  recommendationIndex: 1,
  recommendation: {
    materialId: "mat-1",
    materialTitle: "Orbits handout",
    pageRange: { start: 3, end: 4 },
    reason: "Circular motion",
    pages: [{ pageNumber: 3, imageUrl: "https://signed.test/3.png" }],
  },
};
const simulation: CoachActionView = {
  cardId: "card-s",
  kind: "simulation",
  simulation: {
    simulationId: "sim-1",
    title: "Orbit lab",
    topic: "Gravity",
    learningGoal: "See orbits",
    version: 2,
  },
  goal: "Change the mass",
  steps: ["Drag the slider", "Watch the path"],
  observe: "The orbit radius",
};
const practice: CoachActionView = {
  cardId: "card-p",
  kind: "practice",
  reason: "Same idea",
  question: {
    versionId: "v",
    questionId: "q",
    text: "What pulls the Moon?",
    answerMode: "SINGLE_SELECT",
    answerUnit: null,
    options: [
      { id: "a", text: "Gravity" },
      { id: "b", text: "Wind" },
    ],
  },
  interaction: {
    status: "completed",
    selectedOptionId: "b",
    selectedText: "Wind",
    numericValue: null,
    correct: false,
    completedAt: "2026-11-20T00:00:00Z",
  },
};

async function render(
  actions: CoachActionView[],
  props: Partial<Parameters<typeof CoachActionCards>[0]> = {},
) {
  const onReport = vi.fn();
  await act(async () =>
    root.render(
      <CoachActionCards
        actions={actions}
        target={{ attemptId: "att-1", questionNumber: 2 }}
        conversationId="conv-1"
        onReport={onReport}
        {...props}
      />,
    ),
  );
  return onReport;
}

describe("CoachActionCards telemetry and persistence", () => {
  it("records a material open as coach telemetry and as a card interaction", async () => {
    const onInteractionSaved = vi.fn();
    await render([material], { onInteractionSaved });
    expect(host.textContent).not.toContain("Viewed");
    expect(telemetryCalls.at(-1)).toMatchObject({
      surface: "coach_recommendation",
      attemptId: "att-1",
      materialId: "mat-1",
    });

    await act(async () => button(/open orbits handout/i)!.click());
    await flush();
    expect(calls).toEqual([
      {
        url: "/api/assistant/card-interaction",
        body: {
          conversationId: "conv-1",
          cardId: "card-m",
          kind: "material",
          materialId: "mat-1",
          recommendationIndex: 1,
        },
      },
    ]);
    expect(host.textContent).toContain("Viewed");
    expect(onInteractionSaved).toHaveBeenCalledWith(
      "card-m",
      expect.objectContaining({ status: "viewed" }),
    );
  });

  it("labels widget material opens as assistant recommendations and files them by question when there is no conversation", async () => {
    await render([material], {
      source: "widget",
      conversationId: null,
    });
    expect(telemetryCalls.at(-1)).toMatchObject({
      surface: "assistant_recommendation",
    });
    await act(async () => button(/open orbits handout/i)!.click());
    await flush();
    expect(calls[0].body).toMatchObject({
      attemptId: "att-1",
      questionNumber: 2,
      kind: "material",
    });
  });

  it("opens a simulation with coach telemetry and records it as explored", async () => {
    await render([simulation]);
    await act(async () => button(/open simulation/i)!.click());
    await flush();
    expect(simCalls.at(-1)).toEqual({
      attemptId: "att-1",
      surface: "coach_recommendation",
    });
    expect(calls[0]).toEqual({
      url: "/api/assistant/card-interaction",
      body: {
        conversationId: "conv-1",
        cardId: "card-s",
        kind: "simulation",
        simulationId: "sim-1",
      },
    });
    expect(host.textContent).toContain("Explored");
  });

  it("shows saved interactions when a transcript is reopened", async () => {
    await render([
      {
        ...simulation,
        interaction: {
          status: "opened",
          openedAt: "2026-11-20T00:00:00Z",
          lastInteractedAt: "2026-11-20T00:00:00Z",
        },
      },
      {
        ...material,
        interaction: { status: "viewed", viewedAt: "2026-11-20T00:00:00Z" },
      },
    ]);
    expect(host.textContent).toContain("Explored");
    expect(host.textContent).toContain("Viewed");
    expect(calls).toHaveLength(0);
  });

  it("hydrates a completed practice card: saved choice, locked inputs, verdict", async () => {
    const onReport = await render([practice]);
    const wind = host.querySelector(
      'input[type="radio"][value="b"]',
    ) as HTMLInputElement;
    expect(wind.checked).toBe(true);
    expect(host.querySelector("fieldset")?.disabled).toBe(true);
    expect(host.textContent).toContain("Not quite.");
    expect(host.textContent).toContain("You answered: Wind");
    expect(button(/check my answer/i)).toBeUndefined();
    expect(onReport).not.toHaveBeenCalled();
  });

  it("locks diagnostic options that were already chosen", async () => {
    const onReport = await render([
      {
        cardId: "card-d",
        kind: "diagnostic_options",
        prompt: "What happened?",
        options: [
          { id: "x", label: "I guessed" },
          { id: "y", label: "I ran out of time" },
        ],
        interaction: {
          status: "selected",
          selectedOptionId: "y",
          selectedLabel: "I ran out of time",
          selectedAt: "2026-11-20T00:00:00Z",
        },
      },
    ]);
    expect(button(/^I ran out of time/)!.textContent).toContain("Selected");
    await act(async () => button(/^I guessed/)!.click());
    expect(onReport).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("disables every interaction when read-only", async () => {
    const onReport = await render(
      [
        {
          cardId: "card-d",
          kind: "diagnostic_options",
          prompt: "What happened?",
          options: [{ id: "x", label: "I guessed" }],
        },
      ],
      { readOnly: true },
    );
    await act(async () => button(/^I guessed/)!.click());
    expect(onReport).not.toHaveBeenCalled();
  });

  it("saves a diagnostic pick before reporting it, so the next turn sees it", async () => {
    let release!: () => void;
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        await new Promise<void>((resolve) => (release = resolve));
        order.push("saved");
        return Response.json({
          interaction: {
            status: "selected",
            selectedOptionId: "x",
            selectedLabel: "I guessed",
            selectedAt: "2026-11-20T00:00:00Z",
          },
        });
      }),
    );
    const onReport = await render([
      {
        cardId: "card-d",
        kind: "diagnostic_options",
        prompt: "What happened?",
        options: [{ id: "x", label: "I guessed" }],
      },
    ]);
    onReport.mockImplementation(() => order.push("reported"));
    await act(async () => button(/^I guessed/)!.click());
    // A second click before the save settles does nothing.
    await act(async () => button(/^I guessed/)!.click());
    expect(onReport).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    await act(async () => release());
    await flush();
    expect(order).toEqual(["saved", "reported"]);
    expect(onReport).toHaveBeenCalledWith("I guessed");
  });

  it("still reports a diagnostic pick when saving it fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const onReport = await render([
      {
        cardId: "card-d",
        kind: "diagnostic_options",
        prompt: "What happened?",
        options: [{ id: "x", label: "I guessed" }],
      },
    ]);
    await act(async () => button(/^I guessed/)!.click());
    await flush();
    expect(onReport).toHaveBeenCalledWith("I guessed");
  });

  it("sends legacy cards without a card id so the server can match them", async () => {
    const { cardId: _omit, ...legacy } = simulation;
    await render([legacy as CoachActionView]);
    await act(async () => button(/open simulation/i)!.click());
    await flush();
    expect(calls).toEqual([
      {
        url: "/api/assistant/card-interaction",
        body: {
          conversationId: "conv-1",
          kind: "simulation",
          simulationId: "sim-1",
        },
      },
    ]);
  });

  it("withdraws the Viewed badge when the save fails and retries on the next open", async () => {
    let ok = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return ok
          ? Response.json({
              interaction: {
                status: "viewed",
                viewedAt: "2026-11-20T00:00:00Z",
              },
            })
          : new Response(null, { status: 500 });
      }),
    );
    await render([material]);
    await act(async () => button(/open orbits handout/i)!.click());
    await flush();
    expect(host.textContent).not.toContain("Viewed");

    ok = true;
    await act(async () => button(/open orbits handout/i)!.click());
    await flush();
    expect(calls).toHaveLength(2);
    expect(host.textContent).toContain("Viewed");

    // Recorded: later opens don't post again.
    await act(async () => button(/open orbits handout/i)!.click());
    await flush();
    expect(calls).toHaveLength(2);
  });
});

describe("CoachActionCards practice submission", () => {
  const openPractice: CoachActionView = {
    ...practice,
    interaction: undefined,
  } as CoachActionView;

  function holdPractice() {
    const pending: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        await new Promise<void>((resolve) => pending.push(resolve));
        return Response.json({ correct: true, selectedText: "Gravity" });
      }),
    );
    return pending;
  }

  const choose = () =>
    act(async () =>
      (
        host.querySelector('input[type="radio"][value="a"]') as HTMLInputElement
      ).click(),
    );

  it("checks an answer once even when submitted twice before re-rendering", async () => {
    const pending = holdPractice();
    const onReport = await render([openPractice]);
    await choose();
    const form = host.querySelector("form")!;
    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
    });
    expect(
      calls.filter((c) => c.url === "/api/assistant/coach/practice"),
    ).toHaveLength(1);
    await act(async () => pending.forEach((resolve) => resolve()));
    await flush();
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Correct!");
  });

  it("drops a result that arrives after the card left the screen", async () => {
    const pending = holdPractice();
    const onReport = await render([openPractice]);
    await choose();
    await act(async () => host.querySelector("form")!.requestSubmit());
    expect(calls).toHaveLength(1);
    // The student switched conversations: a different transcript is mounted.
    await act(async () => root.render(<div />));
    await act(async () => pending.forEach((resolve) => resolve()));
    await flush();
    expect(onReport).not.toHaveBeenCalled();
  });
});
