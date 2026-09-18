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
function version(mode: string, index: number) {
  return {
    id: `${mode}-${index}`,
    name: `${mode} ${index}`,
    variation: mode,
    status: "REVIEW",
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
    error: null,
    aiModel: "test",
  };
}
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let versions: ReturnType<typeof version>[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  versions = ["NUMBERS", "CONTEXT"].flatMap((mode) =>
    [1, 2, 3, 4].map((n) => version(mode, n)),
  );
  fetchMock = vi.fn(async (_url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      versions = [
        {
          ...version(body.variation, 5),
          objectives: body.objectives,
          status: "QUEUED",
          questions: [],
        },
        ...versions,
      ];
      return new Response(JSON.stringify({ status: "QUEUED" }), {
        status: 202,
      });
    }
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
async function render() {
  await act(async () =>
    root.render(
      <StrictMode>
        <QuizVariants quizId="quiz" questions={[source]} />
      </StrictMode>,
    ),
  );
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (el) => el.textContent === text,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
const posts = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
it("shows original choices and two cached alternatives, switches modes and cycles pairs without generating", async () => {
  await render();
  const card = host.querySelector("article")!;
  expect(card.textContent).toContain("What is 2 + 2?");
  expect(card.textContent).toContain("A.4Correct");
  expect(card.textContent).toContain("NUMBERS example 1");
  expect(card.textContent).toContain("NUMBERS example 2");
  expect(card.textContent).not.toContain("NUMBERS example 3");
  await click("Show two more");
  expect(card.textContent).toContain("NUMBERS example 3");
  await click("Context, numbers & choices");
  expect(card.textContent).toContain("CONTEXT example 1");
  expect(posts()).toHaveLength(0);
});
it.each(["Enter", "Save"])(
  "generates a restricted batch on %s, but not while typing or Shift+Enter",
  async (action) => {
    await render();
    const box = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(box, "Use only whole numbers.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(posts()).toHaveLength(0);
    await act(async () =>
      box.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    expect(posts()).toHaveLength(0);
    if (action === "Save") await click("Save & preview");
    else
      await act(async () =>
        box.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
      );
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1].body)).toMatchObject({
      count: 4,
      objectives: [
        { sourceQuestionId: "q1", objective: "Use only whole numbers." },
      ],
    });
    expect(host.querySelector("article")!.textContent).not.toContain(
      "NUMBERS example 1",
    );
  },
);
it("pre-generates eight previews once, including under StrictMode", async () => {
  versions = [];
  await render();
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(posts()[0][1].body)).toMatchObject({
    count: 4,
    bothModes: true,
  });
});
it("does not automatically generate for unsupported questions", async () => {
  versions = [];
  await act(async () =>
    root.render(
      <QuizVariants
        quizId="quiz"
        questions={[{ ...source, figureUrl: "/figure.png" }]}
      />,
    ),
  );
  expect(posts()).toHaveLength(0);
});
