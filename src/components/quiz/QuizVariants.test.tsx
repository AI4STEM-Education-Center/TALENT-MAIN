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
const numbersSample = {
  question: {
    ...source,
    id: "sample-n",
    text: "What is 3 + 3?",
    options: [
      { id: "a", text: "6", isCorrect: true },
      { id: "b", text: "7", isCorrect: false },
    ],
    solution: "3 + 3 = 6",
    intentExplanation: "Addition",
  },
  check: {
    sourceQuestionId: "q1",
    intentPreserved: true,
    unambiguous: true,
    answerNumeric: null,
    correctOptionId: "a",
    explanation: "Numbers check out",
  },
};
const contextSample = {
  question: {
    ...numbersSample.question,
    id: "sample-c",
    text: "Ana has 3 apples and buys 3 more. How many now?",
  },
  check: { ...numbersSample.check, explanation: "Scenario verified" },
};
const variantsUrl = "/api/quizzes/quiz/variants";
const sampleUrl = "/api/quizzes/quiz/variants/sample";
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let versions: ReturnType<typeof version>[];
let sampleReply: () => Response;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  versions = ["NUMBERS", "CONTEXT"].flatMap((mode) =>
    [1, 2].map((n) => version(mode, n)),
  );
  // Like a worker that has not produced a sample: no preview payload.
  sampleReply = () =>
    new Response(JSON.stringify({ status: "QUEUED" }), { status: 202 });
  fetchMock = vi.fn(async (url, init) => {
    if (url === sampleUrl) return sampleReply();
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
/** Let in-flight fetches (sample preview, list refresh) settle. */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function type(box: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const row = (label: string) =>
  host.querySelector(`section[aria-label="${label}"]`)!;
const cell = (label: string) =>
  host.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const sent = (method: string, url = variantsUrl) =>
  fetchMock.mock.calls
    .filter(([target, init]) => target === url && init?.method === method)
    .map(([, init]) => JSON.parse(init.body));

it("previews both styles, then starts the chosen mix in the background and closes", async () => {
  versions = [];
  sampleReply = () =>
    new Response(
      JSON.stringify({
        sourceQuestionId: "q1",
        numbersSample,
        contextSample,
        aiModel: "test",
      }),
    );
  await render();
  expect(sent("POST")).toHaveLength(0);
  await click("Generate new version");
  await flush();
  const popup = dialog()!;
  expect(popup).toBeTruthy();
  expect(sent("POST", sampleUrl).at(-1)).toEqual({
    questionId: "q1",
    objective,
  });
  const styleA = popup.querySelector(
    'section[aria-label="Style A · Limited Numerical"]',
  )!;
  const styleB = popup.querySelector(
    'section[aria-label="Style B · Full Question Rewrite"]',
  )!;
  expect(styleA.textContent).toContain("Numbers & choices");
  expect(styleA.textContent).toContain("What is 3 + 3?");
  expect(styleA.textContent).toContain("Numbers check out");
  expect(styleB.textContent).toContain("Fresh scenario & choices");
  expect(styleB.textContent).toContain("Ana has 3 apples");
  // 2 + 2 and the alternate purpose are the defaults.
  expect(
    popup.querySelector<HTMLInputElement>('input[value="2-2"]')!.checked,
  ).toBe(true);
  expect(
    popup.querySelector<HTMLInputElement>('input[value="ALTERNATE"]')!.checked,
  ).toBe(true);
  await act(async () =>
    popup.querySelector<HTMLInputElement>('input[value="4-0"]')!.click(),
  );
  await act(async () =>
    popup.querySelector<HTMLInputElement>('input[value="STANDALONE"]')!.click(),
  );
  versions = [1, 2, 3, 4].map((n) =>
    version("NUMBERS", n, {
      status: "GENERATING",
      questions: [],
      slotIndex: n - 1,
      completedCount: 0,
      totalCount: 1,
    }),
  );
  await click("Generate 4 versions in background", popup);
  await flush();
  expect(sent("POST")).toEqual([
    {
      name: "Version",
      mix: "4-0",
      purpose: "STANDALONE",
      objectives: [{ sourceQuestionId: "q1", objective }],
      seedSamples: { numbersSample, contextSample },
    },
  ]);
  expect(dialog()).toBeNull();
  expect(host.textContent).toContain("0 of 4 versions verified");
  expect(host.textContent).toContain("Generating in the background");
  expect(
    host.querySelector('a[href="/teacher/quizzes/quiz/versions/batch-1"]')
      ?.textContent,
  ).toBe("Open batch review link");
});

it("still starts a round when no preview sample is available", async () => {
  versions = [];
  await render();
  await click("Generate new version");
  await flush();
  const popup = dialog()!;
  expect(popup.textContent).toContain("A preview isn't available right now");
  await act(async () =>
    popup.querySelector<HTMLInputElement>('input[value="0-4"]')!.click(),
  );
  await click("Generate 4 versions in background", popup);
  await flush();
  expect(sent("POST")).toEqual([
    {
      name: "Version",
      mix: "0-4",
      purpose: "ALTERNATE",
      objectives: [{ sourceQuestionId: "q1", objective }],
    },
  ]);
  expect(dialog()).toBeNull();
});

it("offers a retry when the preview fails", async () => {
  versions = [];
  sampleReply = () =>
    new Response(JSON.stringify({ error: "Preview quota reached" }), {
      status: 429,
    });
  await render();
  await click("Generate new version");
  await flush();
  const popup = dialog()!;
  expect(popup.textContent).toContain("Preview quota reached");
  const before = sent("POST", sampleUrl).length;
  await click("Retry preview", popup);
  expect(sent("POST", sampleUrl).length).toBeGreaterThan(before);
  expect(button("Generate 4 versions in background", popup)!.disabled).toBe(
    false,
  );
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

it("blocks bulk approval when the exam changed since generation", async () => {
  await render([{ ...source, text: "What is 2 + 3?" }]);
  const numbers = row("Numbers & choices");
  expect(button("Approve both as alternates", numbers)!.disabled).toBe(true);
  expect(button("Approve as alternate", numbers)!.disabled).toBe(true);
});

it("shows all four drafts of a 4-0 round without an empty context row", async () => {
  versions = [4, 3, 2, 1].map((n) =>
    version("NUMBERS", n, { slotIndex: n - 1 }),
  );
  await render();
  expect(row("Context, numbers & choices")).toBeNull();
  const numbers = row("Numbers & choices");
  const text = numbers.textContent!;
  for (const n of [1, 2, 3, 4]) expect(text).toContain(`NUMBERS example ${n}`);
  // Slots stay in order: 1 and 2 compared first, then 3 and 4.
  expect(text.indexOf("NUMBERS example 2")).toBeLessThan(
    text.indexOf("NUMBERS example 3"),
  );
  await click("Approve all 4 as alternates", numbers);
  expect(sent("PATCH").map((b) => b.versionId)).toEqual([
    "NUMBERS-1",
    "NUMBERS-2",
    "NUMBERS-3",
    "NUMBERS-4",
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

it("stages single-question revisions across drafts and submits them together", async () => {
  const second = {
    ...source,
    id: "q2",
    sourceQuestionId: "q2",
    text: "What is 5 + 1?",
  };
  versions = versions.map((v) => ({
    ...v,
    sourceSnapshot: [source, second],
    questions: [
      ...v.questions,
      { ...v.questions[0], id: `${v.id}-q2`, sourceQuestionId: "q2" },
    ],
  }));
  await render([source, second]);
  await click("Send back for revision", cell("NUMBERS 1, question 1"));
  await click("Send back for revision", cell("CONTEXT 2, question 2"));
  expect(cell("NUMBERS 1, question 2").textContent).toContain("Kept unchanged");
  expect(cell("NUMBERS 2, question 1").textContent).not.toContain(
    "Kept unchanged",
  );
  const bar = host.querySelector('section[aria-label="Staged revisions"]')!;
  expect(bar.textContent).toContain(
    "2 questions staged for revision across 2 versions — unflagged questions stay unchanged",
  );
  expect(button("Submit all revisions", bar)!.disabled).toBe(true);
  await type(
    host.querySelector<HTMLTextAreaElement>("#revision-NUMBERS-1-q1")!,
    "Use whole numbers",
  );
  await type(
    host.querySelector<HTMLTextAreaElement>("#revision-CONTEXT-2-q2")!,
    " Change the scenario ",
  );
  await click("Submit all revisions", bar);
  expect(sent("PATCH")).toEqual([
    {
      action: "revise_batch",
      batchId: "batch-1",
      revisions: [
        {
          versionId: "NUMBERS-1",
          questionRevisions: [
            { sourceQuestionId: "q1", reason: "Use whole numbers" },
          ],
        },
        {
          versionId: "CONTEXT-2",
          questionRevisions: [
            { sourceQuestionId: "q2", reason: "Change the scenario" },
          ],
        },
      ],
    },
  ]);
  expect(
    host.querySelector('section[aria-label="Staged revisions"]'),
  ).toBeNull();
});

it("regenerates a draft with teacher feedback", async () => {
  await render();
  const box = host.querySelector<HTMLTextAreaElement>("#feedback-NUMBERS-2")!;
  await type(box, "Use smaller numbers.");
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

it("keeps earlier rounds with unapproved drafts visible", async () => {
  versions.push(
    version("CONTEXT", 0, {
      batchId: "older-round",
      createdAt: "2026-09-20T00:00:00.000Z",
    }),
  );
  await render();
  const earlier = host.querySelector(
    'section[aria-labelledby="earlier-rounds"]',
  )!;
  expect(earlier.textContent).toContain("Earlier rounds awaiting review");
  expect(earlier.textContent).toContain("CONTEXT example 0");
  expect(
    earlier.querySelector(
      'a[href="/teacher/quizzes/quiz/versions/older-round"]',
    ),
  ).toBeTruthy();
  // The newest round stays the prominent one.
  expect(row("Numbers & choices").textContent).toContain("NUMBERS example 1");
});

it("shows generation progress and failures without exposing unverified drafts", async () => {
  versions[0] = {
    ...versions[0],
    status: "GENERATING",
    questions: [],
    completedCount: 1,
    totalCount: 3,
  } as (typeof versions)[number];
  versions[1] = {
    ...versions[1],
    status: "FAILED",
    error: "No draft passed verification after 4 attempts.",
  };
  await render();
  const numbers = row("Numbers & choices");
  expect(numbers.textContent).toContain(
    "Generating and verifying (1/3 questions)…",
  );
  expect(numbers.textContent).toContain("No draft passed verification");
  expect(button("Approve as alternate", numbers)).toBeUndefined();
  expect(host.textContent).toContain("2 of 4 versions verified");
  expect(host.textContent).toContain("NUMBERS 1: 1/3 questions");
  await click("Regenerate", numbers);
  expect(sent("PATCH")).toEqual([{ versionId: "NUMBERS-2", action: "retry" }]);
  expect(button("Generate new version")!.disabled).toBe(true);
});

it("disables generation for unsupported questions", async () => {
  versions = [];
  await render([{ ...source, figureUrl: "/figure.png" } as typeof source]);
  expect(button("Generate new version")!.disabled).toBe(true);
});

it("shows saved version questions, answers and verification after a newer round exists", async () => {
  versions.push(
    version("NUMBERS", 0, {
      status: "PUBLISHED",
      batchId: "older-round",
      validation: [
        { sourceQuestionId: "q1", explanation: "Independently verified" },
      ],
    }),
  );
  await render();
  const inspect = [...host.querySelectorAll("details")].find(
    (el) => el.querySelector("summary")?.textContent === "Inspect NUMBERS 0",
  );
  expect(inspect).toBeTruthy();
  expect(inspect?.textContent).toContain("NUMBERS example 0");
  expect(inspect?.textContent).toContain("Correct");
  expect(inspect?.textContent).toContain("Worked answer");
  expect(inspect?.textContent).toContain("Independently verified");
});
