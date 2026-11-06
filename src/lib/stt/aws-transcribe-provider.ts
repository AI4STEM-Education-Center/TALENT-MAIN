// Browser-side Amazon Transcribe Streaming provider implementing `SttProvider`.
//
// Connects the browser microphone directly to AWS Transcribe Streaming over a
// SigV4-presigned WebSocket URL minted by `/api/assistant/stt`, encodes 16-bit
// PCM audio into AWS event-stream binary frames, and decodes incoming
// `TranscriptEvent` messages.

import {
  startMicrophoneCapture,
  type AudioCaptureHandle,
} from "./audio-capture";
import { encodeAudioEvent, parseTranscribeFrame } from "./aws-eventstream";
import type {
  SttActiveSession,
  SttProvider,
  SttSessionCallbacks,
} from "./types";

const CONNECT_TIMEOUT_MS = 10_000;
/**
 * Maximum time to wait after sending the empty end-of-stream `AudioEvent` for
 * Amazon Transcribe to flush any remaining final `TranscriptEvent` frames and
 * close the WebSocket.
 */
const FINALIZE_TIMEOUT_MS = 3_500;
/**
 * Settling window after the last non-partial `TranscriptEvent` arrives during
 * finalization when no provisional results remain open.
 */
const FINALIZE_IDLE_SETTLE_MS = 450;

interface PresignResponse {
  url: string;
  region: string;
  sampleRate: number;
  languageCode: string;
  identifyLanguage: boolean;
  expiresIn: number;
  error?: string;
}

export class AwsTranscribeSttProvider implements SttProvider {
  readonly id = "aws_transcribe" as const;

  async startSession(
    callbacks: SttSessionCallbacks,
    options?: { surface?: string },
  ): Promise<SttActiveSession> {
    const surface = options?.surface ?? "student_assistant";

    // 1. Request microphone access first so permission denial fails fast
    //    before minting a presigned URL or opening a WebSocket.
    const pendingChunks: Int16Array[] = [];
    let socketReady = false;
    let ws: WebSocket | null = null;
    let aborted = false;
    let finalizing = false;
    let startedAt = 0;

    const sendPcmChunk = (pcm16: Int16Array) => {
      if (aborted || finalizing) return;
      if (!socketReady || !ws || ws.readyState !== WebSocket.OPEN) {
        // Buffer up to ~3 seconds (30 chunks) while the WebSocket handshake completes
        if (pendingChunks.length < 30) {
          pendingChunks.push(pcm16);
        }
        return;
      }
      try {
        const frame = encodeAudioEvent(pcm16);
        ws.send(frame);
      } catch {
        // Handled by WebSocket error/close listeners
      }
    };

    const audioHandle: AudioCaptureHandle =
      await startMicrophoneCapture(sendPcmChunk);

    // 2. Fetch the short-lived SigV4-presigned WebSocket URL from our backend.
    let presign: PresignResponse;
    try {
      const res = await fetch("/api/assistant/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "presign", surface }),
      });
      const data = (await res.json().catch(() => null)) as PresignResponse | null;
      if (!res.ok || !data?.url) {
        throw new Error(
          data?.error ??
            "Voice input is unavailable right now. Please try again shortly.",
        );
      }
      presign = data;
    } catch (err) {
      audioHandle.stop();
      throw err instanceof Error
        ? err
        : new Error("Could not start voice input.");
    }

    // 3. Open the direct WebSocket to Amazon Transcribe Streaming.
    let hasPartialOpen = false;
    let finalizeResolve: ((res: { durationMs: number }) => void) | null = null;
    let finalizeReject: ((err: Error) => void) | null = null;
    let finalizeTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let usageReported = false;

    const reportUsage = (durationMs: number) => {
      if (usageReported || durationMs < 200) return;
      usageReported = true;
      void fetch("/api/assistant/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          surface,
          durationMs: Math.round(durationMs),
          languageCode: presign.languageCode,
        }),
        keepalive: true,
      }).catch(() => {});
    };

    const clearTimers = () => {
      if (finalizeTimer) {
        clearTimeout(finalizeTimer);
        finalizeTimer = null;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
    };

    const finishFinalization = () => {
      if (!finalizeResolve) return;
      const resolve = finalizeResolve;
      finalizeResolve = null;
      finalizeReject = null;
      clearTimers();
      const durationMs = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
      reportUsage(durationMs);
      try {
        if (
          ws &&
          (ws.readyState === WebSocket.OPEN ||
            ws.readyState === WebSocket.CONNECTING)
        ) {
          ws.close(1000);
        }
      } catch {
        // Ignore
      }
      resolve({ durationMs });
    };

    const failFinalization = (message: string) => {
      if (finalizeReject) {
        const reject = finalizeReject;
        finalizeResolve = null;
        finalizeReject = null;
        clearTimers();
        reject(new Error(message));
      } else if (!aborted) {
        callbacks.onError(message);
      }
    };

    await new Promise<void>((resolveConnect, rejectConnect) => {
      let connected = false;
      const connectTimer = setTimeout(() => {
        if (!connected) {
          aborted = true;
          audioHandle.stop();
          try {
            ws?.close();
          } catch {
            // Ignore
          }
          rejectConnect(
            new Error(
              "Timed out connecting to Amazon Transcribe. Please check your connection and try again.",
            ),
          );
        }
      }, CONNECT_TIMEOUT_MS);

      try {
        ws = new WebSocket(presign.url);
        ws.binaryType = "arraybuffer";
      } catch (err) {
        clearTimeout(connectTimer);
        audioHandle.stop();
        rejectConnect(
          err instanceof Error
            ? err
            : new Error("Failed to open transcription WebSocket."),
        );
        return;
      }

      ws.onopen = () => {
        clearTimeout(connectTimer);
        if (aborted) {
          try {
            ws?.close();
          } catch {
            // Ignore
          }
          return;
        }
        connected = true;
        socketReady = true;
        startedAt = Date.now();

        // Flush any initial audio chunks captured during the WS handshake
        while (pendingChunks.length > 0 && ws?.readyState === WebSocket.OPEN) {
          const chunk = pendingChunks.shift()!;
          try {
            ws.send(encodeAudioEvent(chunk));
          } catch {
            break;
          }
        }

        callbacks.onReady();
        resolveConnect();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (aborted) return;
        if (!(event.data instanceof ArrayBuffer)) return;

        try {
          const parsed = parseTranscribeFrame(event.data);
          if (parsed.kind === "exception") {
            const friendly = formatTranscribeException(
              parsed.exceptionType,
              parsed.message,
            );
            audioHandle.stop();
            failFinalization(friendly);
            return;
          }
          if (parsed.kind === "transcript") {
            for (const item of parsed.events) {
              hasPartialOpen = item.isPartial;
              callbacks.onTranscript(item);
            }
            // If we are finalizing and the stream just delivered a final
            // segment (`!hasPartialOpen`), schedule a short settle timer so we
            // don't wait the full timeout if AWS is done speaking.
            if (finalizing && !hasPartialOpen) {
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(() => {
                finishFinalization();
              }, FINALIZE_IDLE_SETTLE_MS);
            }
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onerror = () => {
        clearTimeout(connectTimer);
        audioHandle.stop();
        if (!connected) {
          rejectConnect(
            new Error(
              "Could not connect to Amazon Transcribe Streaming. Verify AWS credentials and Transcribe permissions.",
            ),
          );
          return;
        }
        failFinalization(
          "Lost connection to voice transcription before finishing.",
        );
      };

      ws.onclose = (event: CloseEvent) => {
        clearTimeout(connectTimer);
        audioHandle.stop();
        if (!connected) {
          rejectConnect(
            new Error(
              "Connection to Amazon Transcribe closed before streaming could start.",
            ),
          );
          return;
        }
        if (finalizing) {
          finishFinalization();
        } else if (!aborted && event.code !== 1000) {
          callbacks.onError(
            "Voice transcription disconnected unexpectedly. Your draft has been preserved.",
          );
        }
      };
    });

    return {
      finalize: () => {
        if (aborted) {
          return Promise.resolve({ durationMs: 0 });
        }
        if (finalizing && finalizeResolve) {
          return new Promise((res, rej) => {
            const prevRes = finalizeResolve;
            const prevRej = finalizeReject;
            finalizeResolve = (val) => {
              prevRes?.(val);
              res(val);
            };
            finalizeReject = (err) => {
              prevRej?.(err);
              rej(err);
            };
          });
        }

        // Stop the microphone first — this flushes any remaining sub-chunk via
        // `sendPcmChunk` while `finalizing` is still false, then stops the
        // MediaStreamTracks so the browser recording indicator turns off right away.
        audioHandle.stop();
        finalizing = true;

        return new Promise<{ durationMs: number }>((resolve, reject) => {
          finalizeResolve = resolve;
          finalizeReject = reject;

          if (!ws || ws.readyState !== WebSocket.OPEN) {
            finishFinalization();
            return;
          }

          try {
            // Empty AudioEvent signals end-of-stream to Amazon Transcribe
            ws.send(encodeAudioEvent(new Uint8Array(0)));
          } catch {
            finishFinalization();
            return;
          }

          // If no provisional transcript is currently open, settle quickly
          // while still allowing any in-flight final packet to arrive.
          if (!hasPartialOpen) {
            settleTimer = setTimeout(() => {
              finishFinalization();
            }, FINALIZE_IDLE_SETTLE_MS);
          }

          finalizeTimer = setTimeout(() => {
            finishFinalization();
          }, FINALIZE_TIMEOUT_MS);
        });
      },

      abort: () => {
        if (aborted) return;
        aborted = true;
        clearTimers();
        finalizeResolve = null;
        finalizeReject = null;
        const durationMs =
          startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
        reportUsage(durationMs);
        audioHandle.stop();
        try {
          if (
            ws &&
            (ws.readyState === WebSocket.OPEN ||
              ws.readyState === WebSocket.CONNECTING)
          ) {
            ws.close(1000);
          }
        } catch {
          // Ignore
        }
      },
    };
  }
}

function formatTranscribeException(type: string, message: string): string {
  if (
    type.includes("AccessDenied") ||
    type.includes("UnrecognizedClient") ||
    type.includes("IncompleteSignature") ||
    type.includes("InvalidSignature") ||
    message.toLowerCase().includes("not authorized")
  ) {
    return "AWS Transcribe permission denied. Ensure the IAM user has transcribe:StartStreamTranscriptionWebSocket permission.";
  }
  if (type.includes("LimitExceeded") || type.includes("Throttling")) {
    return "Voice transcription rate limit reached. Please wait a moment and try again.";
  }
  return message || "Voice transcription encountered an error.";
}

export const defaultSttProvider: SttProvider = new AwsTranscribeSttProvider();
