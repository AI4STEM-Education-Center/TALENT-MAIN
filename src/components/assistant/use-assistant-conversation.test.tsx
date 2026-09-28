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
