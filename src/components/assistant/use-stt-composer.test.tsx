// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSttComposer, type SttComposerController } from "./use-stt-composer";
import type {
  SttActiveSession,
  SttProvider,
  SttSessionCallbacks,
} from "@/lib/stt/types";

interface MockProviderHandle {
  provider: SttProvider;
  getCallbacks: () => SttSessionCallbacks;
  resolveFinalize: () => void;
  rejectFinalize: (err: Error) => void;
  wasAborted: () => boolean;
  finalizeCount: () => number;
}

function createMockSttProvider(options?: {
  failStartWith?: Error;
  manualFinalize?: boolean;
}): MockProviderHandle {
  let latestCallbacks: SttSessionCallbacks | null = null;
  let finalizeRes: (() => void) | null = null;
  let finalizeRej: ((err: Error) => void) | null = null;
  let aborted = false;
  let finalizes = 0;

  const provider: SttProvider = {
    id: "aws_transcribe",
    startSession: vi.fn(async (callbacks: SttSessionCallbacks) => {
      if (options?.failStartWith) {
        throw options.failStartWith;
      }
      latestCallbacks = callbacks;
      callbacks.onReady();

      const session: SttActiveSession = {
        finalize: () => {
          finalizes += 1;
          if (!options?.manualFinalize) {
            return Promise.resolve({ durationMs: 1200 });
          }
          return new Promise<{ durationMs: number }>((res, rej) => {
            finalizeRes = () => res({ durationMs: 1200 });
            finalizeRej = rej;
          });
        },
        abort: () => {
          aborted = true;
        },
      };
      return session;
    }),
  };

  return {
    provider,
    getCallbacks: () => {
      if (!latestCallbacks) throw new Error("Session not started");
      return latestCallbacks;
    },
    resolveFinalize: () => finalizeRes?.(),
    rejectFinalize: (err: Error) => finalizeRej?.(err),
    wasAborted: () => aborted,
    finalizeCount: () => finalizes,
  };
}

function mountSttHook(
  mockProvider: SttProvider,
  onSendSpy: (text: string) => Promise<void> | void,
  initialDraft = "",
) {
  const container = document.createElement("div");
  const root = createRoot(container);
  let latestDraft = initialDraft;
  let controller!: SttComposerController;

  function Harness() {
    const [draft, setDraftState] = useState(initialDraft);
    const setDraft = (val: string) => {
      latestDraft = val;
      setDraftState(val);
    };
    controller = useSttComposer({
      draft,
      setDraft,
      onSend: async (text) => {
        await onSendSpy(text);
        setDraft("");
      },
      provider: mockProvider,
    });
    return null;
  }

  act(() => {
    root.render(<Harness />);
  });

  return {
    get controller() {
      return controller;
    },
    get draft() {
      return latestDraft;
    },
    unmount: () => {
      act(() => root.unmount());
    },
  };
}

describe("useSttComposer state machine", () => {
  beforeEach(() => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Scenario A: starts STT, streams partial and final results into draft, and stopping STT never auto-sends", async () => {
    const mock = createMockSttProvider();
    const sent: string[] = [];
    const harness = mountSttHook(mock.provider, (text) => {
      sent.push(text);
    });

    await act(async () => {
      await harness.controller.toggleStt();
    });
    expect(harness.controller.state).toBe("recording");

    act(() => {
      mock.getCallbacks().onTranscript({
        resultId: "r-1",
        transcript: "What is",
        isPartial: true,
      });
    });
    expect(harness.draft).toBe("What is");

    // Partial update replaces provisional text rather than duplicating
    act(() => {
      mock.getCallbacks().onTranscript({
        resultId: "r-1",
        transcript: "What is Newton's second law?",
        isPartial: false,
      });
    });
    expect(harness.draft).toBe("What is Newton's second law?");

    // User clicks Stop STT -> finalizes and stays in input without sending
    await act(async () => {
      await harness.controller.toggleStt();
    });
    expect(harness.controller.state).toBe("idle");
    expect(harness.draft).toBe("What is Newton's second law?");
    expect(sent).toEqual([]);

    harness.unmount();
  });

  it("Scenario B & C: pressing Send/Enter while recording stops mic, awaits final AWS transcript, merges with typed text, and submits once", async () => {
    const mock = createMockSttProvider({ manualFinalize: true });
    const sent: string[] = [];
    const harness = mountSttHook(
      mock.provider,
      (text) => {
        sent.push(text);
      },
      "Question 3:",
    );

    await act(async () => {
      await harness.controller.startStt();
    });
    expect(harness.controller.state).toBe("recording");

    act(() => {
      mock.getCallbacks().onTranscript({
        resultId: "r-1",
        transcript: "how do I find",
        isPartial: true,
      });
    });
    expect(harness.draft).toBe("Question 3: how do I find");

    // User clicks Send (or presses Enter) while still recording
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = harness.controller.submitOrFinalizeAndSend();
    });
    expect(harness.controller.state).toBe("finalizing");

    // Repeated Send/Enter clicks while finalizing do not trigger a second finalize or send
    act(() => {
      void harness.controller.submitOrFinalizeAndSend();
    });

    // Final AWS transcript arrives before finalization resolves
    act(() => {
      mock.getCallbacks().onTranscript({
        resultId: "r-1",
        transcript: "how do I find acceleration?",
        isPartial: false,
      });
    });

    await act(async () => {
      mock.resolveFinalize();
      await sendPromise;
    });

    expect(mock.finalizeCount()).toBe(1);
    expect(sent).toEqual(["Question 3: how do I find acceleration?"]);
    expect(harness.draft).toBe("");
    expect(harness.controller.state).toBe("idle");

    harness.unmount();
  });

  it("preserves the draft and does not send incomplete text when AWS finalization fails during immediate send", async () => {
    const mock = createMockSttProvider({ manualFinalize: true });
    const sent: string[] = [];
    const harness = mountSttHook(
      mock.provider,
      (text) => {
        sent.push(text);
      },
      "Typed:",
    );

    await act(async () => {
      await harness.controller.startStt();
    });

    act(() => {
      mock.getCallbacks().onTranscript({
        resultId: "r-1",
        transcript: "partial thought",
        isPartial: true,
      });
    });

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = harness.controller.submitOrFinalizeAndSend();
    });

    await act(async () => {
      mock.rejectFinalize(new Error("Connection lost during finalization."));
      await sendPromise;
    });

    expect(sent).toEqual([]);
    expect(harness.draft).toBe("Typed: partial thought");
    expect(harness.controller.state).toBe("error");
    expect(harness.controller.error).toContain(
      "Connection lost during finalization.",
    );

    harness.unmount();
  });

  it("does not send a blank message when an empty recording is submitted", async () => {
    const mock = createMockSttProvider();
    const sent: string[] = [];
    const harness = mountSttHook(mock.provider, (text) => {
      sent.push(text);
    });

    await act(async () => {
      await harness.controller.startStt();
    });
    await act(async () => {
      await harness.controller.submitOrFinalizeAndSend();
    });

    expect(sent).toEqual([]);
    expect(harness.controller.state).toBe("idle");
    harness.unmount();
  });

  it("surfaces a clear error on microphone permission denial and cleans up on unmount", async () => {
    const denied = createMockSttProvider({
      failStartWith: new Error(
        "Microphone access was denied. Please allow microphone permission in your browser settings and try again.",
      ),
    });
    const sent: string[] = [];
    const harness = mountSttHook(
      denied.provider,
      (text) => {
        sent.push(text);
      },
      "Keep my draft",
    );

    await act(async () => {
      await harness.controller.startStt();
    });

    expect(harness.controller.state).toBe("error");
    expect(harness.controller.error).toContain("Microphone access was denied");
    expect(harness.draft).toBe("Keep my draft");
    harness.unmount();

    // Verify unmount aborts an active recording session
    const activeMock = createMockSttProvider();
    const activeHarness = mountSttHook(activeMock.provider, () => {});
    await act(async () => {
      await activeHarness.controller.startStt();
    });
    expect(activeMock.wasAborted()).toBe(false);
    activeHarness.unmount();
    expect(activeMock.wasAborted()).toBe(true);
  });
});
