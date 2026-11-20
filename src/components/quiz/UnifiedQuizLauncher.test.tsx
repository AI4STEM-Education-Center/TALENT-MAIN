// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedQuizOverview } from "@/lib/quiz-overview";

const { players } = vi.hoisted(() => ({
  players: [] as Record<string, unknown>[],
}));
vi.mock("./QuizPlayer", () => ({
  QuizPlayer: (props: Record<string, unknown>) => {
    players.push(props);
    const back = props.onBackToSetup as (mode?: string) => void;
    return (
      <div data-testid="player">
        Playing {String(props.mode)}
        <button type="button" onClick={() => back("practice")}>
          Practice another version
        </button>
      </div>
    );
  },
}));

import { UnifiedQuizLauncher } from "./UnifiedQuizLauncher";

const overview = (
  patch: Partial<UnifiedQuizOverview> = {},
): UnifiedQuizOverview => ({
  classId: "c1",
  quiz: { id: "q1", name: "Forces quiz", topicName: "Mechanics" },
  availability: {
    notOpenYet: false,
    closed: false,
    attemptsExhausted: false,
    locked: false,
  },
  availableFrom: null,
  availableUntil: null,
  maxAttempts: 3,
  gradedAttemptCount: 1,
  gradedAttempt: null,
  practiceAvailableCount: 2,
  practiceCanStart: true,
  practiceAttempt: null,
  previouslyCorrect: ["a", "b"],
  questions: [
    { id: "a", number: 1, previewText: "What is a force?" },
    { id: "b", number: 2, previewText: "Units of force?" },
    { id: "c", number: 3, previewText: "Newton's third law" },
  ],
  recentAttempts: [
    {
      id: "att-2",
      kind: "alternative",
      versionName: "Version B",
      score: 66.7,
      excludedCount: 1,
      startedAt: "2026-11-18T15:00:00.000Z",
      completedAt: "2026-11-18T15:10:00.000Z",
    },
    {
      id: "att-1",
      kind: "official",
      versionName: null,
      score: 50,
      excludedCount: 0,
      startedAt: "2026-11-17T15:00:00.000Z",
      completedAt: "2026-11-17T15:10:00.000Z",
    },
  ],
  ...patch,
});

let root: Root;
let host: HTMLElement;
let responses: UnifiedQuizOverview[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  players.length = 0;
  responses = [];
  fetchMock = vi.fn(async () =>
    Response.json(responses.length > 1 ? responses.shift() : responses[0]),
  );
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

const flush = () =>
  act(async () => void (await new Promise((r) => setTimeout(r, 0))));

async function mount(
  data: UnifiedQuizOverview,
  initialMode: "official" | "practice" = "official",
) {
  responses.push(data);
  await act(async () =>
    root.render(
      <UnifiedQuizLauncher
        classId="c1"
        quizId="q1"
        initialMode={initialMode}
        backHref="/student/classes/c1"
        backLabel="Back to class"
      />,
    ),
  );
  await flush();
}

const button = (label: RegExp) =>
  [...host.querySelectorAll("button")].find((b) =>
    label.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
const click = async (label: RegExp) => {
  const target = button(label);
  if (!target) throw new Error(`No button ${label}`);
  await act(async () => target.click());
};
const radio = (name: RegExp) =>
  [...host.querySelectorAll('[role="radio"]')].find((el) =>
    name.test(el.textContent ?? ""),
  ) as HTMLElement;
const masterToggle = () =>
  host.querySelector('input[type="checkbox"]') as HTMLInputElement;

describe("UnifiedQuizLauncher", () => {
  it("loads the overview and switches between the official quiz and an alternative version", async () => {
    await mount(overview());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/quiz?classId=c1&quizId=q1",
      expect.anything(),
    );
    expect(host.textContent).toContain("Forces quiz");
    expect(radio(/official quiz/i).getAttribute("aria-checked")).toBe("true");
    expect(radio(/official quiz/i).textContent).toContain("Attempts 1/3");
    expect(radio(/alternative version/i).textContent).toContain(
      "2 versions published",
    );

    await act(async () => radio(/alternative version/i).click());
    expect(radio(/alternative version/i).getAttribute("aria-checked")).toBe(
      "true",
    );
    await click(/start alternative version/i);
    expect(players.at(-1)).toMatchObject({
      mode: "practice",
      classId: "c1",
      quizId: "q1",
      exclusionOptions: { excludeCorrect: true },
    });
  });

  it("skips previously-correct questions by default, and lets the student pick individual ones", async () => {
    await mount(overview());
    expect(masterToggle().checked).toBe(true);
    expect(host.textContent).toContain(
      "Skip all 2 questions I already answered correctly",
    );
    expect(host.textContent).toContain("1 question left to practice");

    await click(/choose individual questions \(1 of 3 selected\)/i);
    const list = host.querySelector(
      '[aria-label="Questions in this attempt"]',
    )!;
    expect(list.querySelectorAll("li")).toHaveLength(3);
    expect(list.textContent).toContain("Answered correctly");
    expect(list.textContent).toContain(
      "Missed / not yet right — always included",
    );
    // A missed question has no Skip control at all.
    expect(
      host.querySelector('input[aria-label="Skip question 3"]'),
    ).toBeNull();

    const skipQ2 = host.querySelector(
      'input[aria-label="Skip question 2"]',
    ) as HTMLInputElement;
    await act(async () => skipQ2.click());
    expect(masterToggle().checked).toBe(false);
    expect(masterToggle().indeterminate).toBe(true);
    expect(host.textContent).toContain("2 of 3 selected");

    await click(/start official quiz/i);
    expect(players.at(-1)).toMatchObject({
      mode: "student",
      exclusionOptions: { excludedQuestionIds: ["a"] },
    });
  });

  it("sends no exclusion when the student turns skipping off", async () => {
    await mount(overview());
    await act(async () => masterToggle().click());
    expect(host.textContent).toContain("3 questions");
    await click(/start official quiz/i);
    expect(players.at(-1)?.exclusionOptions).toEqual({});
  });

  it("explains that the full quiz is used when everything was right before", async () => {
    await mount(overview({ previouslyCorrect: ["a", "b", "c"] }));
    expect(host.textContent).toContain(
      "answered every question correctly before, so the full quiz",
    );
    expect(masterToggle()).toBeNull();
  });

  it("resumes an in-progress attempt without offering opt-outs", async () => {
    await mount(
      overview({
        gradedAttempt: {
          id: "att-3",
          startedAt: "2026-11-19T15:00:00.000Z",
          excludedQuestionIds: ["a"],
        },
      }),
    );
    expect(radio(/official quiz/i).textContent).toContain("In progress");
    expect(host.textContent).toContain(
      "Continuing picks up the same question set — 1 question you already answered correctly was left out",
    );
    expect(masterToggle()).toBeNull();
    await click(/continue official quiz/i);
    expect(players.at(-1)?.exclusionOptions).toEqual({});
  });

  it("falls back to the open mode and explains a locked one", async () => {
    await mount(
      overview({
        gradedAttemptCount: 3,
        availability: {
          notOpenYet: false,
          closed: false,
          attemptsExhausted: true,
          locked: true,
        },
      }),
      "official",
    );
    expect(radio(/alternative version/i).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(radio(/official quiz/i).textContent).toContain(
      "You've used all 3 graded attempts.",
    );
    await act(async () => radio(/official quiz/i).click());
    expect(button(/start official quiz/i)?.disabled).toBe(true);
  });

  it("shows no alternative versions as locked", async () => {
    await mount(
      overview({ practiceAvailableCount: 0, practiceCanStart: false }),
      "practice",
    );
    expect(radio(/official quiz/i).getAttribute("aria-checked")).toBe("true");
    expect(radio(/alternative version/i).textContent).toContain(
      "No alternative versions have been published",
    );
  });

  it("lists official and alternative attempts together with result links", async () => {
    await mount(overview());
    const recent = host.querySelector('[aria-labelledby="recent-attempts"]')!;
    expect(recent.textContent).toContain("Alternative: Version B");
    expect(recent.textContent).toContain("67%");
    expect(recent.textContent).toContain("1 question skipped");
    expect(recent.textContent).toContain("Official");
    expect(
      [...recent.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    ).toEqual(["/student/results/att-2", "/student/results/att-1"]);
  });

  it("returns to setup with refreshed history after a finished attempt", async () => {
    await mount(overview());
    await click(/start official quiz/i);
    expect(host.textContent).toContain("Playing student");
    responses.splice(0, responses.length, overview({ gradedAttemptCount: 2 }));
    await click(/practice another version/i);
    await flush();
    expect(host.querySelector('[data-testid="player"]')).toBeNull();
    expect(radio(/official quiz/i).textContent).toContain("Attempts 2/3");
    expect(radio(/alternative version/i).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("renders LaTeX in question previews", async () => {
    await mount(
      overview({
        questions: [
          { id: "a", number: 1, previewText: "Find $x^2$ when x = 3" },
          { id: "b", number: 2, previewText: "Units of force?" },
          { id: "c", number: 3, previewText: "Newton's third law" },
        ],
      }),
    );
    await click(/choose individual questions/i);
    const list = host.querySelector(
      'ul[aria-label="Questions in this attempt"]',
    )!;
    expect(list.querySelector(".katex")).not.toBeNull();
    expect(list.textContent).not.toContain("$x^2$");
  });

  it("follows the radiogroup keyboard contract: one tab stop, arrows switch", async () => {
    await mount(overview());
    const official = radio(/official quiz/i);
    const practice = radio(/alternative version/i);
    expect(official.tabIndex).toBe(0);
    expect(practice.tabIndex).toBe(-1);

    official.focus();
    await act(async () =>
      official.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(practice.getAttribute("aria-checked")).toBe("true");
    expect(practice.tabIndex).toBe(0);
    expect(official.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(practice);

    await act(async () =>
      practice.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    // Wraps around.
    expect(official.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(official);
  });

  it("holds Start until the refreshed overview arrives", async () => {
    await mount(overview());
    await click(/start official quiz/i);

    const gates: ((data: UnifiedQuizOverview) => void)[] = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          gates.push((data) => resolve(Response.json(data))),
        ),
    );
    await click(/practice another version/i);
    const start = () => button(/(start|continue) /i)!;
    expect(start().disabled).toBe(true);

    await act(async () => start().click());
    expect(host.querySelector('[data-testid="player"]')).toBeNull();

    await act(async () => gates[0](overview({ gradedAttemptCount: 2 })));
    await flush();
    expect(start().disabled).toBe(false);
    expect(radio(/official quiz/i).textContent).toContain("Attempts 2/3");
  });

  it("drops an older overview that finishes after a newer one", async () => {
    const gates = new Map<string, (data: UnifiedQuizOverview) => void>();
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise<Response>((resolve) =>
          gates.set(String(url), (data) => resolve(Response.json(data))),
        ),
    );
    const render = (quizId: string) =>
      act(async () =>
        root.render(
          <UnifiedQuizLauncher
            classId="c1"
            quizId={quizId}
            initialMode="official"
            backHref="/student/classes/c1"
            backLabel="Back to class"
          />,
        ),
      );
    await render("q1");
    await render("q2");
    const [first, second] = [...gates.keys()];
    await act(async () =>
      gates.get(second)!(
        overview({ quiz: { id: "q2", name: "Energy quiz", topicName: null } }),
      ),
    );
    await flush();
    await act(async () => gates.get(first)!(overview()));
    await flush();
    expect(host.textContent).toContain("Energy quiz");
    expect(host.textContent).not.toContain("Forces quiz");
  });

  it("keeps the cached overview but blocks launching when a refresh fails, with a retry", async () => {
    await mount(overview());
    await click(/start official quiz/i);
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ error: "Server down" }, { status: 500 }),
    );
    await click(/practice another version/i);
    await flush();
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Could not refresh this quiz");
    expect(button(/start alternative version/i)!.disabled).toBe(true);
    // The cached overview is still on screen.
    expect(radio(/official quiz/i).textContent).toContain("Attempts 1/3");

    await click(/try again/i);
    await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button(/start alternative version/i)!.disabled).toBe(false);
  });
});
