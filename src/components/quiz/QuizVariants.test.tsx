// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuizVariants } from "./QuizVariants";

const objective =
  "Preserve the original learning objective, reasoning steps, units, and difficulty.";
const source = {
  id: "q1",
  sourceQuestionId: "q1",
  text: "What is 2 + 2?",
  answerMode: "SINGLE_SELECT",
  answerNumeric: null,
  answerUnit: null,
  answerTolerance: null,
  options: [
    { id: "a", text: "4", isCorrect: true },
    { id: "b", text: "5", isCorrect: false },
  ],
};
function version(
  mode: string,
  index: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `${mode}-${index}`,
    name: `${mode} ${index}`,
    variation: mode,
    status: "REVIEW",
    purpose: "ALTERNATE",
    batchId: "batch-1",
    createdAt: `2026-09-25T00:00:0${index}.000Z`,
    sourceSnapshot: [source],
    objectives: [{ sourceQuestionId: "q1", objective }],
    questions: [
      {
        ...source,
        id: `${mode}-q-${index}`,
        text: `${mode} example ${index}`,
        solution: "Worked answer",
        intentExplanation: "Addition",
      },
    ],
    validation: [],
    error: null as string | null,
    aiModel: "test",
    standaloneQuiz: null,
    ...extra,
  };
}
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let versions: ReturnType<typeof version>[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  versions = ["NUMBERS", "CONTEXT"].flatMap((mode) =>
    [1, 2].map((n) => version(mode, n)),
  );
  fetchMock = vi.fn(async (_url, init) => {
    if (init?.method === "POST" || init?.method === "PATCH")
      return new Response(JSON.stringify({ status: "QUEUED" }), {
        status: 202,
      });
    return new Response(JSON.stringify({ versions }));
  });
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
async function render(questions = [source]) {
  await act(async () =>
    root.render(
      <StrictMode>
        <QuizVariants
          quizId="quiz"
          questions={questions}
          quizHrefBase="/teacher/quizzes"
        />
      </StrictMode>,
    ),
  );
}
function button(text: string, scope: ParentNode = host) {
  return [...scope.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === text,
  );
}
async function click(text: string, scope: ParentNode = host) {
  const target = button(text, scope)!;
  expect(target).toBeTruthy();
  await act(async () => target.click());
}
const row = (label: string) =>
  host.querySelector(`section[aria-label="${label}"]`)!;
const sent = (method: string) =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === method)
    .map(([, init]) => JSON.parse(init.body));

it("starts nothing on load, then generates a 2×2 round for the chosen purpose", async () => {
  versions = [];
  await render();
  expect(sent("POST")).toHaveLength(0);
  await click("Generate new version");
  await click(
    "Standalone examA separate exam you can edit, assign, and grade on its own.",
  );
  expect(sent("POST")).toEqual([
    {
      name: "Version",
      variation: "NUMBERS",
      count: 2,
      bothModes: true,
      purpose: "STANDALONE",
      objectives: [{ sourceQuestionId: "q1", objective }],
    },
  ]);
});

it("compares the original with two drafts per mode and approves with one click", async () => {
  await render();
  const numbers = row("Numbers & choices");
  expect(numbers.textContent).toContain("What is 2 + 2?");
  expect(numbers.textContent).toContain("NUMBERS example 1");
  expect(numbers.textContent).toContain("NUMBERS example 2");
  expect(row("Context, numbers & choices").textContent).toContain(
    "CONTEXT example 2",
  );
  await click("Approve as alternate", numbers);
  await click("Save as standalone exam", row("Context, numbers & choices"));
  expect(sent("PATCH")).toEqual([
    { versionId: "NUMBERS-1", action: "publish" },
    { versionId: "CONTEXT-1", action: "standalone" },
  ]);
});

it("saves both drafts at once and offers two more alternates", async () => {
  await render();
  const numbers = row("Numbers & choices");
  await click("Approve both as alternates", numbers);
  expect(sent("PATCH")).toEqual([
    { versionId: "NUMBERS-1", action: "publish" },
    { versionId: "NUMBERS-2", action: "publish" },
  ]);
  await click("Generate two more", numbers);
  expect(sent("POST")).toEqual([
    {
      name: "Version",
      variation: "NUMBERS",
      count: 2,
      objectives: [{ sourceQuestionId: "q1", objective }],
      batchId: "batch-1",
    },
  ]);
});

it("offers two more for a standalone round only after an alternate is approved", async () => {
  versions = versions.map((v) => ({ ...v, purpose: "STANDALONE" }));
  versions[0] = { ...versions[0], status: "PUBLISHED" };
  await render();
  expect(button("Generate two more", row("Numbers & choices"))).toBeTruthy();
  expect(
    button("Generate two more", row("Context, numbers & choices")),
  ).toBeUndefined();
});

it("regenerates a draft with teacher feedback", async () => {
  await render();
  const box = host.querySelector<HTMLTextAreaElement>("#feedback-NUMBERS-2")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(box, "Use smaller numbers.");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const slot = box.closest("div.p-4")!;
  await click("Regenerate with feedback", slot);
  expect(sent("PATCH")).toEqual([
    {
      versionId: "NUMBERS-2",
      action: "revise",
      feedback: "Use smaller numbers.",
    },
  ]);
});

it("shows generation progress and failures without exposing unverified drafts", async () => {
  versions[0] = { ...versions[0], status: "GENERATING", questions: [] };
  versions[1] = {
    ...versions[1],
    status: "FAILED",
    error: "No draft passed verification after 4 attempts.",
  };
  await render();
  const numbers = row("Numbers & choices");
  expect(numbers.textContent).toContain("Generating and verifying…");
  expect(numbers.textContent).toContain("No draft passed verification");
  expect(button("Approve as alternate", numbers)).toBeUndefined();
  await click("Regenerate", numbers);
  expect(sent("PATCH")).toEqual([{ versionId: "NUMBERS-2", action: "retry" }]);
  expect(button("Generate new version")!.disabled).toBe(true);
});

it("disables generation for unsupported questions", async () => {
  versions = [];
  await render([{ ...source, figureUrl: "/figure.png" } as typeof source]);
  expect(button("Generate new version")!.disabled).toBe(true);
});
