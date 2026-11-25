"use client";

import { useEffect, useState } from "react";
import {
  isResultPending,
  RESULT_STATUS,
  type PresignedRecommendation,
  type ResultComponentMetrics,
  type ResultStatus,
  type SimulationRecommendationView,
} from "@/lib/exam-results";

const RECONNECT_MS = 1000;

/** Statuses retrying cannot fix: signed out, not allowed, or no such attempt. */
const PERMANENT_HTTP = new Set([401, 403, 404]);

export type AiState = {
  summary: string | null;
  summaryStatus: ResultStatus;
  summaryMetrics: ResultComponentMetrics | null;
  recommendations: PresignedRecommendation[];
  simulations: SimulationRecommendationView[];
  recommendationsStatus: ResultStatus;
  recommendationMetrics: ResultComponentMetrics | null;
  truncated: boolean;
};

/**
 * The attempt's AI sections, kept live: while the summary or recommendations
 * are still generating, follow the result stream (reconnecting if it drops)
 * until both reach a terminal status.
 */
export function useStreamedResults(attemptId: string, initial: AiState) {
  const [ai, setAi] = useState<AiState>(initial);
  const needPoll =
    isResultPending(ai.summaryStatus) ||
    isResultPending(ai.recommendationsStatus);

  useEffect(() => {
    if (!needPoll) return;
    let active = true;
    const abort = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let receivedTerminal = false;

    const applyUpdate = (data: AiState) => {
      if (!active) return;
      receivedTerminal =
        !isResultPending(data.summaryStatus) &&
        !isResultPending(data.recommendationsStatus);
      setAi({
        summary: data.summary ?? null,
        summaryStatus: data.summaryStatus,
        summaryMetrics: data.summaryMetrics ?? null,
        recommendations: Array.isArray(data.recommendations)
          ? data.recommendations
          : [],
        simulations: Array.isArray(data.simulations) ? data.simulations : [],
        recommendationsStatus: data.recommendationsStatus,
        recommendationMetrics: data.recommendationMetrics ?? null,
        truncated: data.truncated === true,
      });
    };

    // Give up on a permanent error: whatever was still generating is shown
    // as failed (with its own retry affordance) instead of spinning forever.
    const stopAsFailed = () => {
      if (!active) return;
      setAi((prev) => ({
        ...prev,
        summaryStatus: isResultPending(prev.summaryStatus)
          ? RESULT_STATUS.FAILED
          : prev.summaryStatus,
        recommendationsStatus: isResultPending(prev.recommendationsStatus)
          ? RESULT_STATUS.FAILED
          : prev.recommendationsStatus,
      }));
    };

    const connect = async () => {
      while (active) {
        try {
          const res = await fetch(
            `/api/student/attempts/${attemptId}/results?stream=1`,
            { signal: abort.signal },
          );
          if (PERMANENT_HTTP.has(res.status)) {
            stopAsFailed();
            return;
          }
          if (!res.ok || !res.body)
            throw new Error("Result stream unavailable");

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffered = "";

          while (active) {
            const { done, value } = await reader.read();
            buffered += decoder.decode(value, { stream: !done });
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim()) applyUpdate(JSON.parse(line));
            }
            if (done) {
              if (buffered.trim()) applyUpdate(JSON.parse(buffered));
              if (receivedTerminal) return;
              throw new Error(
                "Result stream ended before generation completed",
              );
            }
          }
        } catch {
          if (!active || abort.signal.aborted) return;
          await new Promise<void>((resolve) => {
            reconnectTimer = setTimeout(resolve, RECONNECT_MS);
          });
        }
      }
    };

    void connect();
    return () => {
      active = false;
      abort.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [attemptId, needPoll]);

  return ai;
}
