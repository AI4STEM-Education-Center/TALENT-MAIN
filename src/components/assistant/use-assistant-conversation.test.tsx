// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAssistantConversation,
  type AssistantConversation,
} from "./use-assistant-conversation";
import { prepareAttachment, type PreparedAttachment } from "./attachment-input";

vi.mock("./attachment-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./attachment-input")>()),
  prepareAttachment: vi.fn(),
}));

const cleanups: (() => void)[] = [];
const revoke = vi.fn();

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static revokeObjectURL = revoke;
    },
  );
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

async function mount(maxAttachments = 3) {
  let current: AssistantConversation;
  function Harness() {
    current = useAssistantConversation({
      available: true,
      attachmentKinds: [
        { kind: "image", label: "Image", accept: "image/*", maxBytes: 1000 },
      ],
      maxAttachments,
      maxAttachmentBytes: 1000,
    });
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const unmount = () => act(() => root.unmount());
  cleanups.push(unmount);
  return {
    get current() {
      return current!;
    },
    unmount,
  };
}

function attachment(id: string): PreparedAttachment {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    dataBase64: "AA==",
    bytes: 1,
    previewUrl: `blob:${id}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("assistant attachment ownership", () => {
  it("retains existing previews when adding or removing another attachment", async () => {
    const state = await mount();
    vi.mocked(prepareAttachment)
      .mockResolvedValueOnce(attachment("first"))
      .mockResolvedValueOnce(attachment("second"));
    await act(async () => state.current.addFiles([new File([], "first.png")]));
    await act(async () => state.current.addFiles([new File([], "second.png")]));
    expect(revoke).not.toHaveBeenCalled();
    await act(async () => state.current.removeAttachment("second"));
    expect(revoke.mock.calls).toEqual([["blob:second"]]);
    expect(state.current.attachments.map((file) => file.id)).toEqual(["first"]);
    state.unmount();
    expect(revoke.mock.calls).toEqual([["blob:second"], ["blob:first"]]);
  });

  it("reserves attachment slots while preparation is pending", async () => {
    const state = await mount(1);
    const pending = deferred<PreparedAttachment>();
    vi.mocked(prepareAttachment).mockReturnValueOnce(pending.promise);
    let work!: Promise<void>;
    await act(async () => {
      work = state.current.addFiles([new File([], "one.png")]);
    });
    await act(async () => state.current.addFiles([new File([], "two.png")]));
    expect(prepareAttachment).toHaveBeenCalledOnce();
    expect(state.current.preparing).toBe(true);
    await act(async () => {
      pending.resolve(attachment("one"));
      await work;
    });
    expect(state.current.attachments).toHaveLength(1);
    expect(state.current.preparing).toBe(false);
  });

  it("releases previews that finish after starting a new conversation", async () => {
    const state = await mount();
    const pending = deferred<PreparedAttachment>();
    vi.mocked(prepareAttachment).mockReturnValueOnce(pending.promise);
    let work!: Promise<void>;
    await act(async () => {
      work = state.current.addFiles([new File([], "late.png")]);
    });
    await act(async () => state.current.startNewConversation());
    await act(async () => {
      pending.resolve(attachment("late"));
      await work;
    });
    expect(state.current.attachments).toEqual([]);
    expect(revoke).toHaveBeenCalledWith("blob:late");
  });

  it("keeps successful files and reports a peer's read failure", async () => {
    const state = await mount();
    vi.mocked(prepareAttachment)
      .mockResolvedValueOnce(attachment("good"))
      .mockRejectedValueOnce(new Error("Read failed"));
    await act(async () =>
      state.current.addFiles([
        new File([], "good.png"),
        new File([], "bad.png"),
      ]),
    );
    expect(state.current.attachments.map((file) => file.id)).toEqual(["good"]);
    expect(state.current.notice).toMatch(/could not be read/);
    expect(state.current.preparing).toBe(false);
  });
});

describe("assistant request ownership", () => {
  it("ignores an old stream after starting and sending in a new conversation", async () => {
    const state = await mount();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetcher);
    await act(async () => state.current.setDraft("First question"));
    let firstSend!: Promise<void>;
    await act(async () => {
      firstSend = state.current.send();
    });
    await act(async () => state.current.startNewConversation());
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => state.current.setDraft("Second question"));
    let secondSend!: Promise<void>;
    await act(async () => {
      secondSend = state.current.send();
    });
    await act(async () => {
      first.resolve(new Response('{"type":"delta","text":"STALE"}\n'));
      await firstSend;
    });
    expect(state.current.sending).toBe(true);
    expect(state.current.bubbles.at(-1)?.pending).toBe(true);
    await act(async () => {
      second.resolve(
        new Response('{"type":"delta","text":"Current answer"}\n'),
      );
      await secondSend;
    });
    expect(state.current.bubbles.map((bubble) => bubble.content)).toEqual([
      "Second question",
      "Current answer",
    ]);
    expect(state.current.sending).toBe(false);
  });

  it("does not restore a conversation whose fetch completed after New conversation", async () => {
    const state = await mount();
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    let work!: Promise<void>;
    await act(async () => {
      work = state.current.openConversation("old");
    });
    await act(async () => state.current.startNewConversation());
    await act(async () => {
      pending.resolve(
        Response.json({
          turns: [{ role: "assistant", content: "Old answer" }],
        }),
      );
      await work;
    });
    expect(state.current.conversationId).toBeNull();
    expect(state.current.bubbles).toEqual([]);
  });
});

describe("assistant study card transport", () => {
  const card = {
    kind: "practice",
    reason: "Try it",
    target: { attemptId: "result", questionNumber: 1 },
    question: {
      versionId: "v",
      questionId: "q",
      text: "Try $3+3$",
      answerMode: "SINGLE_SELECT",
      answerUnit: null,
      options: [{ id: "a", text: "6" }],
    },
  };

  it("keeps streamed action cards on the assistant bubble and restores hydrated history", async () => {
    const state = await mount();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `${JSON.stringify({ type: "action", action: card })}\n${JSON.stringify({ type: "delta", text: "Try this." })}\n`,
          ),
      ),
    );
    await act(async () => state.current.send("What should I study?"));
    expect(state.current.bubbles[1].cards).toEqual([card]);
    expect(state.current.bubbles[1].content).toBe("Try this.");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          turns: [{ role: "assistant", content: "Earlier", cards: [card] }],
        }),
      })),
    );
    await act(async () => state.current.openConversation("conversation"));
    expect(state.current.bubbles[0].cards).toEqual([card]);
  });
});

describe("reopening saved conversations", () => {
  const question = {
    questionNumber: 4,
    quizName: "Forces",
    answerMode: "SINGLE_SELECT" as const,
    options: [
      {
        label: "A",
        text: "1 N",
        imageUrl: null,
        imageAlt: null,
        selected: true,
      },
    ],
    text: "What is the net force?",
    figureUrl: null,
    figureAlt: null,
    response: { kind: "choices" as const, choices: [] },
    review: null,
  };

  function stubConversations(detail: object) {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(input).startsWith("/api/assistant/conversations/"))
          return Response.json(detail);
        return new Response(
          `${JSON.stringify({ type: "delta", text: "ok" })}\n`,
        );
      }),
    );
    return calls;
  }

  it("restores a coach conversation from its opening and keeps follow-ups on the coach", async () => {
    const calls = stubConversations({
      summary: { id: "conv-c", kind: "coach" },
      turns: [
        { role: "user", content: "I added them", cards: [] },
        {
          role: "assistant",
          content: "Try this",
          cards: [
            {
              cardId: "card-1",
              kind: "diagnostic_options",
              prompt: "Which?",
              options: [{ id: "o", label: "This one" }],
            },
          ],
        },
      ],
      coach: {
        attemptId: "att-9",
        questionNumber: 4,
        opening: "Let's look at question 4.",
        question,
      },
    });
    const state = await mount();
    await act(async () => state.current.openConversation("conv-c"));
    expect(state.current.bubbles.map((b) => b.content)).toEqual([
      "Let's look at question 4.",
      "I added them",
      "Try this",
    ]);
    expect(state.current.coachContext?.attemptId).toBe("att-9");
    expect(state.current.conversationId).toBe("conv-c");
    expect(state.current.attachmentsEnabled).toBe(false);

    await act(async () =>
      state.current.updateCardInteraction("card-1", {
        status: "selected",
        selectedOptionId: "o",
        selectedLabel: "This one",
        selectedAt: "2026-11-20T00:00:00Z",
      }),
    );
    expect(state.current.bubbles[2].cards?.[0]).toMatchObject({
      interaction: { selectedLabel: "This one" },
    });

    await act(async () => state.current.send("Why?"));
    expect(calls.at(-1)).toEqual({
      url: "/api/assistant/coach/chat",
      body: { message: "Why?", attemptId: "att-9", questionNumber: 4 },
    });

    await act(async () => state.current.startNewConversation());
    expect(state.current.coachContext).toBeNull();
    await act(async () => state.current.send("General question"));
    expect(calls.at(-1)?.url).toBe("/api/assistant/chat");
  });

  it("opens an ordinary chat without coach context", async () => {
    const calls = stubConversations({
      summary: { id: "conv-g", kind: "chat" },
      turns: [{ role: "user", content: "Hi", cards: [] }],
    });
    const state = await mount();
    await act(async () => state.current.openConversation("conv-g"));
    expect(state.current.coachContext).toBeNull();
    expect(state.current.bubbles.map((b) => b.content)).toEqual(["Hi"]);
    await act(async () => state.current.send("More"));
    expect(calls.at(-1)?.url).toBe("/api/assistant/chat");
    expect(calls.at(-1)?.body).toMatchObject({ conversationId: "conv-g" });
  });

  it("opens a withheld-key coach transcript read-only and clears it on New conversation", async () => {
    const calls = stubConversations({
      summary: { id: "conv-old", kind: "coach" },
      turns: [{ role: "user", content: "I added them", cards: [] }],
      coach: {
        attemptId: "att-9",
        questionNumber: 4,
        opening: "Let's look at question 4.",
        question,
      },
      readOnly: true,
      readOnlyReason: "The quiz's answer-key policy changed.",
    });
    const state = await mount();
    await act(async () => state.current.openConversation("conv-old"));
    expect(state.current.readOnly).toBe(true);
    expect(state.current.readOnlyReason).toBe(
      "The quiz's answer-key policy changed.",
    );
    const before = calls.length;
    await act(async () => state.current.send("Why?"));
    expect(calls).toHaveLength(before);

    await act(async () => state.current.startNewConversation());
    expect(state.current.readOnly).toBe(false);
    expect(state.current.readOnlyReason).toBeNull();
  });

  it("clears read-only when another conversation is opened", async () => {
    stubConversations({
      summary: { id: "conv-old", kind: "coach" },
      turns: [],
      readOnly: true,
    });
    const state = await mount();
    await act(async () => state.current.openConversation("conv-old"));
    expect(state.current.readOnly).toBe(true);
    stubConversations({
      summary: { id: "conv-g", kind: "chat" },
      turns: [{ role: "user", content: "Hi", cards: [] }],
    });
    await act(async () => state.current.openConversation("conv-g"));
    expect(state.current.readOnly).toBe(false);
  });
});
