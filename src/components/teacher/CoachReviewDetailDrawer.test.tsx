// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CoachReviewDetailDrawer,
  type CoachReviewDetail,
} from "./CoachReviewDetailDrawer";

const detailFixture: CoachReviewDetail = {
  id: "sess-1",
  classId: "cls-1",
  className: "Physics 101",
  quizId: "quiz-1",
  quizName: "Newton's Laws",
  questionNumber: 1,
  studentName: "Alex Student",
  originalQuestionText: "Which pair is a Newton's Third Law pair?",
  originalOptions: [
    {
      label: "A",
      text: "Weight and normal force on the same box",
      isChosen: true,
      isCorrect: false,
      misconceptionCode: "MIS-004",
    },
    {
      label: "B",
      text: "Box on table and table on box",
      isChosen: false,
      isCorrect: true,
      misconceptionCode: null,
    },
  ],
  correctOptionText: "Box on table and table on box",
  chosenOptionText: "Weight and normal force on the same box",
  state: "COMPLETED",
  endedReason: "COMPLETED",
  startedAt: "2026-11-25T00:00:00.000Z",
  completedAt: "2026-11-25T00:05:00.000Z",
  check1Label: "MIS-004",
  explanationText:
    "Not sure what is going on I thought both force are on the car",
  check2Runs: [
    {
      runIndex: 0,
      settled: true,
      valid: true,
      retried: false,
      choice: "neither",
      parsedKind: "neither",
      misconceptionCode: null,
      normalizedVoteKey: "neither",
      probabilities: [
        { value: "sound", probability: 0.01 },
        { value: "neither", probability: 0.96 },
        { value: "MIS-004", probability: 0.02 },
        { value: "MIS-018", probability: 0.01 },
      ],
      confidence: 0.95,
      evidence: null,
      rawResponse: null,
      model: "gpt-6-luna",
      latencyMs: 756,
    },
  ],
  check2ChoiceDefinitions: [
    {
      value: "sound",
      label: "Sound reasoning",
      description:
        "Explanation uses the correct physics idea (even if a misreading or calculation slip occurred).",
      kind: "sound",
    },
    {
      value: "neither",
      label: "Neither / unclear",
      description:
        "Empty, guess ('I don't know'), off-topic, too vague to judge, or matches none of the listed misconceptions.",
      kind: "neither",
    },
    {
      value: "MIS-004",
      label: "Misconception MIS-004",
      description:
        "Confusing balanced forces on a single object with a Newton's Third Law interaction pair.",
      kind: "misconception",
    },
    {
      value: "MIS-018",
      label: "Misconception MIS-018",
      description:
        "Believing a larger object exerts a greater force than a smaller object during an interaction.",
      kind: "misconception",
    },
  ],
  misconceptionStatements: {
    "MIS-004":
      "Confusing balanced forces on a single object with a Newton's Third Law interaction pair.",
    "MIS-018":
      "Believing a larger object exerts a greater force than a smaller object during an interaction.",
  },
  check2ShortCircuitReason: null,
  check2ResultKind: "neither",
  check2MisconceptionCode: null,
  check2TopVoteCount: 5,
  check2VoteHistogram: { neither: 5 },
  check2MeanConfidence: 0.95,
  check2WasTie: false,
  secondQuestionText: "Second question",
  secondQuestionOptions: [],
  check3SelectedText: null,
  check3IsCorrect: null,
  check3Label: null,
  diagnosis: "KNOWLEDGE_GAP",
  diagnosisMisconceptionCode: null,
  decisionTableRow: 9,
  diagnosisReason: "Only one piece points to MIS-004",
  heldOutQuestionText: "Held-out question",
  heldOutQuestionOptions: [],
  heldOutSelectedText: null,
  heldOutIsCorrect: null,
  heldOutLabel: null,
  tutoringMessage: null,
  tutoringAttempts: [],
  tutoringUsedFallback: false,
  classifierModel: "gpt-6-luna",
  classifierProvider: "openai",
  classifierApiSurface: "decisions",
  classifierPromptVersion: "1.0-decisions",
  tutorModel: null,
  tutorProvider: null,
  tutorPromptVersion: null,
  flags: [],
  messages: [],
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ session: detailFixture }))),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("expands a Decisions API run on click to show what each option means", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <CoachReviewDetailDrawer
          sessionId="sess-1"
          apiBasePath="/api/admin/coach-reviews"
          onClose={() => {}}
        />
      </StrictMode>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const runButton = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Run #1:"),
  );
  expect(runButton).toBeTruthy();
  expect(runButton!.getAttribute("aria-expanded")).toBe("false");
  expect(document.body.textContent).not.toContain(
    "Confusing balanced forces on a single object",
  );

  await act(async () => runButton!.click());

  expect(runButton!.getAttribute("aria-expanded")).toBe("true");
  expect(document.body.textContent).toContain("Evaluated options in Run #1");
  expect(document.body.textContent).toContain("Sound reasoning");
  expect(document.body.textContent).toContain("Neither / unclear");
  expect(document.body.textContent).toContain(
    "Confusing balanced forces on a single object with a Newton's Third Law interaction pair.",
  );
  expect(document.body.textContent).toContain(
    "Believing a larger object exerts a greater force than a smaller object during an interaction.",
  );
});

it("displays failed Decisions API runs as failed without marking neither as Selected", async () => {
  const failedFixture: CoachReviewDetail = {
    ...detailFixture,
    check2Runs: [
      {
        runIndex: 0,
        settled: true,
        valid: false,
        retried: true,
        choice: null,
        parsedKind: "neither",
        misconceptionCode: null,
        normalizedVoteKey: "neither",
        probabilities: [],
        confidence: null,
        evidence: null,
        rawResponse: null,
        error: "Provider timeout",
        model: "gpt-6-luna",
        latencyMs: 1200,
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ session: failedFixture }))),
  );
  await act(async () =>
    root.render(
      <StrictMode>
        <CoachReviewDetailDrawer
          sessionId="sess-failed"
          apiBasePath="/api/admin/coach-reviews"
          onClose={() => {}}
        />
      </StrictMode>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const runButton = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.includes("Run #1:"),
  );
  expect(runButton?.textContent).toContain("Failed (fallback: neither)");
  await act(async () => runButton!.click());
  expect(document.body.textContent).toContain("did not return a valid choice");
  expect(document.body.textContent).toContain("Provider timeout");
  const selectedBadges = [...document.querySelectorAll("*")].filter(
    (el) => el.childNodes.length === 1 && el.textContent?.trim() === "Selected",
  );
  expect(selectedBadges).toHaveLength(0);
});
