// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachHistoryContext } from "@/lib/assistant/coach-types";
import type { ConversationSummary } from "@/lib/assistant/types";

const { state } = vi.hoisted(() => ({
  state: {
    coachContext: null as CoachHistoryContext | null,
    historyOpen: false,
    history: [] as ConversationSummary[],
    openConversation: vi.fn(),
    startNewConversation: vi.fn(),
    send: vi.fn(),
    readOnly: false,
    readOnlyReason: null as string | null,
    conversationId: "conv-c" as string | null,
    bubbles: null as unknown[] | null,
  },
}));
vi.mock("./assistant-context", () => ({
  useAssistant: () => ({
    config: { available: true, audience: "student", greeting: "Hi" },
    open: true,
    setOpen: vi.fn(),
  }),
}));
vi.mock("./use-assistant-conversation", () => ({
  useAssistantConversation: () => ({
    readOnly: state.readOnly,
    readOnlyReason: state.readOnlyReason,
    bubbles: state.bubbles ?? [
      { role: "assistant", content: "Let's look at question 4." },
      { role: "user", content: "I added the forces" },
      {
        role: "assistant",
        content: "Which of these fits?",
        cards: [
          {
            cardId: "card-d",
            kind: "diagnostic_options",
            prompt: "Where did it go wrong?",
            options: [
              { id: "o1", label: "Ignored direction" },
              { id: "o2", label: "Wrong units" },
            ],
            interaction: {
              status: "selected",
              selectedOptionId: "o1",
              selectedLabel: "Ignored direction",
              selectedAt: "2026-11-20T00:00:00Z",
            },
          },
        ],
      },
    ],
    activity: [],
    attachments: [],
    conversationId: state.conversationId,
    coachContext: state.coachContext,
    updateCardInteraction: vi.fn(),
    historyOpen: state.historyOpen,
    setHistoryOpen: vi.fn(),
    history: state.history,
    historyDays: 30,
    loadingConversation: false,
    openConversation: state.openConversation,
    startNewConversation: state.startNewConversation,
    openHistory: vi.fn(),
    send: state.send,
  }),
}));
vi.mock("./AssistantComposer", () => ({
  AssistantComposer: () => <form aria-label="Composer" />,
}));

import { AssistantWidget } from "./AssistantWidget";

const coach: CoachHistoryContext = {
  attemptId: "att-9",
  questionNumber: 4,
  opening: "Let's look at question 4.",
  question: {
    questionNumber: 4,
    quizName: "Forces",
    answerMode: "SINGLE_SELECT",
    text: "What is the net force?",
    figureUrl: null,
    figureAlt: null,
    options: [
      {
        label: "A",
        text: "2 N",
        imageUrl: null,
        imageAlt: null,
        selected: false,
      },
      {
        label: "B",
        text: "8 N",
        imageUrl: null,
        imageAlt: null,
        selected: true,
      },
    ],
    response: {
      kind: "choices",
      choices: [{ text: "8 N", imageUrl: null, imageAlt: null }],
    },
    review: null,
  },
};

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal(
    "matchMedia",
    () =>
      ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  state.coachContext = null;
  state.historyOpen = false;
  state.history = [];
  state.readOnly = false;
  state.readOnlyReason = null;
  state.conversationId = "conv-c";
  state.bubbles = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<AssistantWidget />));
const button = (label: RegExp) =>
  [...host.querySelectorAll("button")].find((b) =>
    label.test(`${b.textContent} ${b.getAttribute("aria-label") ?? ""}`),
  ) as HTMLButtonElement | undefined;

describe("coach conversations in the study assistant", () => {
  it("shows a collapsed question drawer that expands to every option and the student's choice", async () => {
    state.coachContext = coach;
    await render();
    const toggle = button(/forces · question 4/i)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Question coach");
    expect(host.textContent).not.toContain("What is the net force?");

    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("What is the net force?");
    expect(host.textContent).toContain("2 N");
    expect(host.textContent).toContain("Your answer");
  });

  it("replays saved cards with the student's recorded choice, locked", async () => {
    state.coachContext = coach;
    await render();
    const chosen = button(/^Ignored direction/)!;
    expect(chosen.textContent).toContain("Selected");
    expect(button(/^Wrong units/)!.disabled).toBe(true);
    await act(async () => button(/^Wrong units/)!.click());
    expect(state.send).not.toHaveBeenCalled();
  });

  it("has no drawer for an ordinary chat", async () => {
    await render();
    expect(host.textContent).not.toContain("Question coach");
  });

  it("lists coach and chat conversations together, badging the coach ones", async () => {
    state.historyOpen = true;
    state.history = [
      {
        id: "c1",
        kind: "coach",
        title: "Question 4 of Forces",
        messageCount: 3,
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      },
      {
        id: "c2",
        kind: "chat",
        title: "Help with vectors",
        messageCount: 2,
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      },
    ];
    await render();
    const items = [...host.querySelectorAll("li button")];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Question coach");
    expect(items[1].textContent).not.toContain("Question coach");
    await act(async () => (items[0] as HTMLButtonElement).click());
    expect(state.openConversation).toHaveBeenCalledWith("c1");
  });

  it("shows a read-only transcript with a banner instead of the composer", async () => {
    state.coachContext = coach;
    state.readOnly = true;
    state.readOnlyReason =
      "The quiz's answer-key policy changed. Open a new coaching conversation to continue.";
    state.bubbles = [
      { role: "assistant", content: "Let's look at question 4." },
      {
        role: "assistant",
        content: "Pick one",
        cards: [
          {
            cardId: "card-d2",
            kind: "diagnostic_options",
            prompt: "Where did it go wrong?",
            options: [{ id: "o1", label: "Ignored direction" }],
          },
        ],
      },
    ];
    await render();
    expect(host.querySelector('form[aria-label="Composer"]')).toBeNull();
    const note = host.querySelector('[role="note"]')!;
    expect(note.textContent).toContain("answer-key policy changed");
    // Cards in the old transcript are inert.
    await act(async () => button(/^Ignored direction/)!.click());
    expect(state.send).not.toHaveBeenCalled();
    await act(async () => button(/start a new conversation/i)!.click());
    expect(state.startNewConversation).toHaveBeenCalled();
  });

  it("keeps the composer for a writable transcript", async () => {
    await render();
    expect(host.querySelector('form[aria-label="Composer"]')).not.toBeNull();
    expect(button(/start a new conversation/i)).toBeUndefined();
  });

  it("never carries a card's local state into another conversation", async () => {
    const fresh = () => [
      {
        role: "assistant",
        content: "Pick one",
        cards: [
          {
            kind: "diagnostic_options",
            prompt: "Where did it go wrong?",
            options: [{ id: "o1", label: "Ignored direction" }],
          },
        ],
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ interaction: null })),
    );
    state.bubbles = fresh();
    state.conversationId = "conv-a";
    await render();
    await act(async () => button(/^Ignored direction/)!.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(button(/^Ignored direction/)!.textContent).toContain("Selected");

    // Same card shape, same slot — but a different conversation.
    state.bubbles = fresh();
    state.conversationId = "conv-b";
    await render();
    expect(button(/^Ignored direction/)!.textContent).not.toContain("Selected");
  });
});
