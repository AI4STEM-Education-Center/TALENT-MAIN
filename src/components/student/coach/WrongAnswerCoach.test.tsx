// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantProvider } from "@/components/assistant/assistant-context";
import { StudentMistakesReview } from "@/components/student/StudentMistakesReview";
import type { StudentMistakeView } from "@/lib/exam-results";
import type {
  CoachPracticeQuestionView,
  CoachSessionView,
} from "@/lib/assistant/coach-types";

const mistakes: StudentMistakeView[] = [
  {
    questionNumber: 3,
    text: "What is $2+2$?",
    figureUrl: null,
    figureAlt: null,
    response: {
      kind: "choices",
      choices: [{ text: "3", imageUrl: null, imageAlt: null }],
    },
  },
];

const practice: CoachPracticeQuestionView = {
  versionId: "v1",
  questionId: "vq1",
  text: "What is 3 + 3?",
  answerMode: "SINGLE_SELECT",
  answerUnit: null,
  options: [
    { id: "a", text: "6" },
    { id: "b", text: "7" },
  ],
};

const session: CoachSessionView = {
  question: {
    questionNumber: 3,
    quizName: "Sums",
    text: "What is 2 + 2?",
    figureUrl: null,
    figureAlt: null,
    response: {
      kind: "choices",
      choices: [{ text: "3", imageUrl: null, imageAlt: null }],
    },
    review: null,
  },
  opening: "Let's look at question 3 together. What were you thinking?",
  conversationId: null,
  turns: [],
};

const ndjson = (events: object[]) =>
  new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), {
    headers: { "Content-Type": "application/x-ndjson" },
  });

type Handlers = Record<string, (init?: RequestInit) => Response>;

function stubFetch(available: boolean, handlers: Handlers = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.startsWith("/api/assistant/config"))
        return Response.json(
          available
            ? { available: true, audience: "student" }
            : { available: false },
        );
      const key = Object.keys(handlers).find((k) => url.startsWith(k));
      if (key) return handlers[key](init);
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollTo = () => {};
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <AssistantProvider>
        <StudentMistakesReview mistakes={mistakes} coachAttemptId="att-1" />
      </AssistantProvider>,
    );
  });
}

const flush = () =>
  act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const button = (label: RegExp) =>
  [...document.querySelectorAll("button")].find((b) =>
    label.test(`${b.textContent} ${b.getAttribute("aria-label") ?? ""}`),
  ) as HTMLButtonElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("StudentMistakesReview coach entry point", () => {
  it("renders no coach control without an attempt id (practice/preview results)", () => {
    expect(
      renderToStaticMarkup(<StudentMistakesReview mistakes={mistakes} />),
    ).not.toContain("Chat with assistant");
  });

  it("hides the button while the student assistant is switched off", async () => {
    stubFetch(false);
    await mount();
    await flush();
    expect(button(/chat with assistant/i)).toBeUndefined();
  });

  it("shows a button on each missed question once the assistant is available", async () => {
    stubFetch(true);
    await mount();
    await flush();
    expect(button(/chat with assistant about question 3/i)).toBeDefined();
  });
});

describe("coach dialog", () => {
  const open = async (handlers: Handlers) => {
    const calls = stubFetch(true, {
      "/api/assistant/coach?": () => Response.json(session),
      ...handlers,
    });
    await mount();
    await flush();
    await act(async () => button(/chat with assistant/i)!.click());
    await flush();
    return calls;
  };

  const type = async (text: string) => {
    const box = document.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("loads the question and the assistant's opening question into an accessible dialog", async () => {
    const calls = await open({});
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("What is 2 + 2?");
    expect(dialog.textContent).toContain("What were you thinking?");
    expect(dialog.querySelector("textarea")?.getAttribute("aria-label")).toBe(
      "Your message",
    );
    expect(
      calls.find((c) => c.url.startsWith("/api/assistant/coach?"))?.url,
    ).toContain("attemptId=att-1&questionNumber=3");
  });

  it("restores focus to the opening button after closing", async () => {
    await open({});
    const trigger = button(/chat with assistant about question 3/i)!;
    await act(async () => button(/\bClose\b/i)!.click());
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("reports a stream that ends without a terminal event", async () => {
    await open({
      "/api/assistant/coach/chat": () =>
        ndjson([{ type: "delta", text: "Partial reply" }]),
    });
    await type("Help me reason about this");
    await act(async () => button(/send message/i)!.click());
    await flush();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      "The connection dropped before the answer finished.",
    );
    await type("Please continue");
    expect(button(/send message/i)?.disabled).toBe(false);
  });

  it("keeps the original question on screen while chatting and renders a streamed practice card", async () => {
    const calls = await open({
      "/api/assistant/coach/chat": () =>
        ndjson([
          { type: "conversation", id: "c1" },
          { type: "delta", text: "Let's try one." },
          {
            type: "action",
            action: {
              kind: "practice",
              reason: "Same skill",
              question: practice,
            },
          },
          {
            type: "done",
            model: "m",
            provider: "p",
            serviceTier: null,
            thinkingLevel: null,
            ttftMs: 1,
            generationMs: 1,
            totalMs: 2,
            tokens: 3,
            tokensEstimated: false,
          },
        ]),
    });
    await type("I added instead of multiplying");
    await act(async () => button(/send message/i)!.click());
    await flush();

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("What is 2 + 2?");
    expect(dialog.textContent).toContain("I added instead of multiplying");
    expect(dialog.textContent).toContain("Let's try one.");
    expect(dialog.textContent).toContain("What is 3 + 3?");
    expect(
      calls.find((c) => c.url === "/api/assistant/coach/chat")?.body,
    ).toEqual({
      message: "I added instead of multiplying",
      attemptId: "att-1",
      questionNumber: 3,
    });
  });

  it("grades an inline practice answer and reports the outcome back to the coach", async () => {
    const calls = await open({
      "/api/assistant/coach/chat": (init) => {
        const sent = JSON.parse(String(init?.body)) as { message: string };
        return sent.message.startsWith("I tried")
          ? ndjson([{ type: "delta", text: "Great, keep going." }])
          : ndjson([
              {
                type: "action",
                action: {
                  kind: "practice",
                  reason: "Same skill",
                  question: practice,
                },
              },
              { type: "delta", text: "Try this." },
            ]);
      },
      "/api/assistant/coach/practice": () => Response.json({ correct: true }),
    });
    await type("hmm");
    await act(async () => button(/send message/i)!.click());
    await flush();

    const radio = document.querySelector(
      'input[type="radio"][value="a"]',
    ) as HTMLInputElement;
    await act(async () => radio.click());
    await act(async () => button(/check my answer/i)!.click());
    await flush();

    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Correct!",
    );
    expect(
      calls.find((c) => c.url === "/api/assistant/coach/practice")?.body,
    ).toEqual({
      attemptId: "att-1",
      questionNumber: 3,
      versionId: "v1",
      questionId: "vq1",
      selectedOptionId: "a",
    });

    await act(async () => button(/tell the assistant how it went/i)!.click());
    await flush();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      "Great, keep going.",
    );
  });

  it("explains an unavailable question instead of showing an empty chat", async () => {
    stubFetch(true, {
      "/api/assistant/coach?": () =>
        Response.json({ error: "Not found" }, { status: 404 }),
    });
    await mount();
    await flush();
    await act(async () => button(/chat with assistant/i)!.click());
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Not found",
    );
  });
});
