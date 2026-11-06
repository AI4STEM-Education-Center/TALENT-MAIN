"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { defaultSttProvider } from "@/lib/stt/aws-transcribe-provider";
import {
  applyTranscriptEvent,
  createTranscriptBuffer,
  formatTranscriptBuffer,
  rebaseTranscriptBuffer,
  settleTranscriptBuffer,
  type TranscriptBufferState,
} from "@/lib/stt/transcript-merger";
import type {
  SttActiveSession,
  SttMachineState,
  SttProvider,
  SttSurface,
  SttTranscriptEvent,
} from "@/lib/stt/types";

export interface UseSttComposerOptions {
  draft: string;
  setDraft: (value: string) => void;
  /**
   * Submit the message. Accepts the exact finalized text so immediate
   * post-recording submission does not depend on a queued React state render.
   */
  onSend: (textToSubmit: string) => Promise<void> | void;
  disabled?: boolean;
  /** True when the composer can send even with empty text (e.g. file attachments). */
  canSendEmptyText?: boolean;
  surface?: SttSurface;
  provider?: SttProvider;
}

export interface SttComposerController {
  state: SttMachineState;
  error: string | null;
  isActive: boolean;
  isRecording: boolean;
  isBusy: boolean;
  /** Toggle STT: starts when idle/error, stops (without sending) when recording/connecting. */
  toggleStt: () => Promise<void>;
  /** Start STT recording if currently idle/error. */
  startStt: () => Promise<void>;
  /** Stop STT recording and finalize into the input without sending. */
  stopStt: () => Promise<void>;
  /**
   * Handle Send button click or Enter key press:
   * - If STT is idle/error: submits `draft` immediately.
   * - If STT is connecting/recording/finalizing: stops recording, awaits final
   *   AWS transcription results, merges with typed text, and submits once.
   */
  submitOrFinalizeAndSend: () => Promise<void>;
  /**
   * Handle manual user edits in the textarea. If STT is active, rebases the
   * transcript buffer so subsequent speech appends to the edited text.
   */
  handleDraftChange: (nextValue: string) => void;
  /** Abort any active STT session immediately (e.g. when starting a new conversation). */
  abortStt: () => void;
  clearError: () => void;
}

export function useSttComposer({
  draft,
  setDraft,
  onSend,
  disabled = false,
  canSendEmptyText = false,
  surface = "student_assistant",
  provider = defaultSttProvider,
}: UseSttComposerOptions): SttComposerController {
  const [state, setState] = useState<SttMachineState>("idle");
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef<SttMachineState>("idle");
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;

  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  const canSendEmptyRef = useRef(canSendEmptyText);
  canSendEmptyRef.current = canSendEmptyText;

  // Monotonically increasing session token so stale async callbacks from an
  // earlier session can never mutate a newer session's state.
  const sessionTokenRef = useRef(0);
  const activeSessionRef = useRef<SttActiveSession | null>(null);
  const bufferRef = useRef<TranscriptBufferState>(createTranscriptBuffer(""));
  // Set when the user clicks Send or presses Enter while STT is connecting/recording/finalizing.
  const submitAfterFinalizeRef = useRef(false);
  // Promise of an in-flight finalization so repeated Stop/Send clicks join the same run.
  const finalizingPromiseRef = useRef<Promise<void> | null>(null);

  const updateState = useCallback((next: SttMachineState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const abortStt = useCallback(() => {
    sessionTokenRef.current += 1;
    submitAfterFinalizeRef.current = false;
    finalizingPromiseRef.current = null;
    const session = activeSessionRef.current;
    activeSessionRef.current = null;
    if (session) {
      session.abort();
    }
    if (stateRef.current !== "idle") {
      updateState("idle");
    }
  }, [updateState]);

  // Clean up microphone, AudioWorklet, and WebSocket on component unmount.
  useEffect(() => {
    return () => {
      sessionTokenRef.current += 1;
      activeSessionRef.current?.abort();
      activeSessionRef.current = null;
    };
  }, []);

  const runFinalize = useCallback(
    async (token: number): Promise<void> => {
      if (finalizingPromiseRef.current) {
        return finalizingPromiseRef.current;
      }

      const promise = (async () => {
        const session = activeSessionRef.current;
        activeSessionRef.current = null;
        updateState("finalizing");

        let finalizationFailed = false;
        if (session) {
          try {
            await session.finalize();
          } catch (err) {
            finalizationFailed = true;
            if (sessionTokenRef.current === token) {
              const msg =
                err instanceof Error
                  ? err.message
                  : "Voice transcription could not be finalized.";
              setError(msg);
            }
          }
        }

        if (sessionTokenRef.current !== token) return;

        // If finalization failed while the user requested immediate submission,
        // preserve whatever confirmed + provisional text we have in the draft
        // and surface the error rather than silently submitting an incomplete
        // transcript.
        if (finalizationFailed) {
          const preserved = formatTranscriptBuffer(bufferRef.current, {
            includeProvisional: true,
          });
          draftRef.current = preserved;
          setDraftRef.current(preserved);
          submitAfterFinalizeRef.current = false;
          updateState("error");
          return;
        }

        // Settle any remaining provisional text into the final buffer and
        // update the composer draft.
        bufferRef.current = settleTranscriptBuffer(bufferRef.current, {
          commitProvisional: true,
        });
        const finalText = formatTranscriptBuffer(bufferRef.current, {
          includeProvisional: false,
        });
        draftRef.current = finalText;
        setDraftRef.current(finalText);

        const shouldSubmit = submitAfterFinalizeRef.current;
        submitAfterFinalizeRef.current = false;

        if (!shouldSubmit) {
          updateState("idle");
          return;
        }

        // Immediate submission requested while recording (Scenario B)
        if (!finalText.trim() && !canSendEmptyRef.current) {
          updateState("idle");
          return;
        }

        updateState("sending");
        try {
          await onSendRef.current(finalText);
          if (sessionTokenRef.current === token) {
            updateState("idle");
          }
        } catch (err) {
          if (sessionTokenRef.current === token) {
            // Preserve the finalized text in the composer if submission fails
            draftRef.current = finalText;
            setDraftRef.current(finalText);
            setError(
              err instanceof Error
                ? err.message
                : "Failed to send message. Your text has been preserved.",
            );
            updateState("error");
          }
        }
      })().finally(() => {
        if (finalizingPromiseRef.current === promise) {
          finalizingPromiseRef.current = null;
        }
      });

      finalizingPromiseRef.current = promise;
      return promise;
    },
    [updateState],
  );

  const startStt = useCallback(async () => {
    if (disabled) return;
    const current = stateRef.current;
    if (
      current === "connecting" ||
      current === "recording" ||
      current === "finalizing" ||
      current === "sending"
    ) {
      return;
    }

    const token = sessionTokenRef.current + 1;
    sessionTokenRef.current = token;
    submitAfterFinalizeRef.current = false;
    bufferRef.current = createTranscriptBuffer(draftRef.current);
    setError(null);
    updateState("connecting");

    try {
      const session = await provider.startSession(
        {
          onReady: () => {
            if (sessionTokenRef.current !== token) return;
            if (stateRef.current === "connecting") {
              updateState("recording");
            }
          },
          onTranscript: (event: SttTranscriptEvent) => {
            if (sessionTokenRef.current !== token) return;
            bufferRef.current = applyTranscriptEvent(bufferRef.current, event);
            const merged = formatTranscriptBuffer(bufferRef.current, {
              includeProvisional: true,
            });
            draftRef.current = merged;
            setDraftRef.current(merged);
          },
          onError: (message: string) => {
            if (sessionTokenRef.current !== token) return;
            activeSessionRef.current = null;
            submitAfterFinalizeRef.current = false;
            // Preserve the draft captured so far
            const preserved = formatTranscriptBuffer(bufferRef.current, {
              includeProvisional: true,
            });
            draftRef.current = preserved;
            setDraftRef.current(preserved);
            setError(message);
            updateState("error");
          },
        },
        { surface },
      );

      if (sessionTokenRef.current !== token) {
        session.abort();
        return;
      }

      activeSessionRef.current = session;
      if (stateRef.current === "connecting") {
        updateState("recording");
      }

      // If the user clicked Send or Stop while the connection handshake was in
      // flight, immediately finalize now that the session is live.
      if (submitAfterFinalizeRef.current) {
        await runFinalize(token);
      }
    } catch (err) {
      if (sessionTokenRef.current !== token) return;
      activeSessionRef.current = null;
      submitAfterFinalizeRef.current = false;
      const message =
        err instanceof Error
          ? err.message
          : "Could not start voice input. Please try again.";
      setError(message);
      updateState("error");
    }
  }, [disabled, provider, runFinalize, surface, updateState]);

  const stopStt = useCallback(async () => {
    const current = stateRef.current;
    if (current === "connecting") {
      // Cancel connection if user stops before handshake completes, unless
      // they asked to submit.
      const token = sessionTokenRef.current;
      if (activeSessionRef.current) {
        await runFinalize(token);
      } else {
        abortStt();
      }
      return;
    }
    if (current !== "recording") return;
    submitAfterFinalizeRef.current = false;
    await runFinalize(sessionTokenRef.current);
  }, [abortStt, runFinalize]);

  const toggleStt = useCallback(async () => {
    const current = stateRef.current;
    if (current === "recording" || current === "connecting") {
      await stopStt();
    } else if (current === "idle" || current === "error") {
      await startStt();
    }
  }, [startStt, stopStt]);

  const submitOrFinalizeAndSend = useCallback(async () => {
    if (disabled) return;
    const current = stateRef.current;

    // Prevent duplicate submissions while already sending
    if (current === "sending") return;

    // Scenario B: STT is active (`connecting`, `recording`, or `finalizing`).
    // Latch `submitAfterFinalizeRef = true` and wait for finalization to finish
    // and automatically submit.
    if (current === "recording") {
      submitAfterFinalizeRef.current = true;
      await runFinalize(sessionTokenRef.current);
      return;
    }

    if (current === "finalizing") {
      submitAfterFinalizeRef.current = true;
      if (finalizingPromiseRef.current) {
        await finalizingPromiseRef.current;
      }
      return;
    }

    if (current === "connecting") {
      submitAfterFinalizeRef.current = true;
      if (activeSessionRef.current) {
        await runFinalize(sessionTokenRef.current);
      }
      return;
    }

    // Normal text-only send when STT is idle or in error state
    const text = draftRef.current;
    if (!text.trim() && !canSendEmptyRef.current) return;

    if (stateRef.current === "error") {
      setError(null);
      updateState("idle");
    }
    await onSendRef.current(text);
  }, [disabled, runFinalize, updateState]);

  const handleDraftChange = useCallback(
    (nextValue: string) => {
      draftRef.current = nextValue;
      setDraftRef.current(nextValue);
      if (
        stateRef.current === "recording" ||
        stateRef.current === "connecting"
      ) {
        bufferRef.current = rebaseTranscriptBuffer(nextValue);
      }
    },
    [],
  );

  const clearError = useCallback(() => {
    setError(null);
    if (stateRef.current === "error") {
      updateState("idle");
    }
  }, [updateState]);

  const isRecording = state === "recording";
  const isActive =
    state === "connecting" || state === "recording" || state === "finalizing";
  const isBusy = state === "finalizing" || state === "sending";

  return {
    state,
    error,
    isActive,
    isRecording,
    isBusy,
    toggleStt,
    startStt,
    stopStt,
    submitOrFinalizeAndSend,
    handleDraftChange,
    abortStt,
    clearError,
  };
}
