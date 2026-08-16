"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScoreBanner } from "@/components/student/QuizReviewResult";
import { ResultSummary } from "@/components/results/ResultSummary";
import { HolisticRecommendations } from "@/components/student/HolisticRecommendations";
import { SimulationRail } from "@/components/student/SimulationRail";
import { StudentMistakesReview } from "@/components/student/StudentMistakesReview";
import { useContentFullWidth } from "@/components/dashboard/content-width";
import { cn } from "@/lib/utils";
import {
  RESULT_STATUS,
  type ResultComponentMetrics,
  type ResultStatus,
  type PresignedRecommendation,
  type SimulationRecommendationView,
  type StudentMistakeView,
} from "@/lib/exam-results";

const RECONNECT_MS = 1000;
type AiState = {
  summary: string | null;
  summaryStatus: ResultStatus;
  summaryMetrics: ResultComponentMetrics | null;
  recommendations: PresignedRecommendation[];
  simulations: SimulationRecommendationView[];
  recommendationsStatus: ResultStatus;
  recommendationMetrics: ResultComponentMetrics | null;
  truncated: boolean;
};

const isPending = (status: ResultStatus) =>
  status === RESULT_STATUS.PENDING || status === RESULT_STATUS.GENERATING;

export function ExamResultsView({
  attemptId,
  score,
  mistakes,
  initial,
  backHref,
  backLabel = "Back",
  actions,
}: {
  attemptId: string;
  score: number;
  mistakes: StudentMistakeView[];
  initial: AiState;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
}) {
  const [ai, setAi] = useState<AiState>(initial);
  // Owned here (not in SimulationRail) because an active simulation reshapes
  // the whole page: the grid flips so the simulation takes the wide side.
  const [activeSimId, setActiveSimId] = useState<string | null>(null);
  const needPoll = isPending(ai.summaryStatus) || isPending(ai.recommendationsStatus);

  useEffect(() => {
    if (!needPoll) return;
    let active = true;
    const abort = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let receivedTerminal = false;

    const applyUpdate = (data: AiState) => {
      if (!active) return;
      receivedTerminal =
        !isPending(data.summaryStatus) && !isPending(data.recommendationsStatus);
      setAi({
        summary: data.summary ?? null,
        summaryStatus: data.summaryStatus,
        summaryMetrics: data.summaryMetrics ?? null,
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
        simulations: Array.isArray(data.simulations) ? data.simulations : [],
        recommendationsStatus: data.recommendationsStatus,
        recommendationMetrics: data.recommendationMetrics ?? null,
        truncated: data.truncated === true,
      });
    };

    const connect = async () => {
      while (active) {
        try {
          const res = await fetch(
            `/api/student/attempts/${attemptId}/results?stream=1`,
            { signal: abort.signal }
          );
          if (!res.ok || !res.body) throw new Error("Result stream unavailable");

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
              throw new Error("Result stream ended before generation completed");
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

  const hasSimulations = ai.simulations.length > 0;
  const simOpen = activeSimId !== null;
  // The dashboard layout caps pages at max-w-7xl, which our own max-w-none
  // can't escape — ask it to lift the cap while a simulation is open.
  useContentFullWidth(simOpen);

  return (
    <div
      className={cn(
        "p-4 md:p-6 space-y-6",
        simOpen ? "max-w-none" : hasSimulations ? "max-w-7xl" : "max-w-6xl"
      )}
    >
      {backHref && (
        <Button variant="ghost" size="sm" asChild>
          <Link href={backHref}>
            <ArrowLeft className="size-4" /> {backLabel}
          </Link>
        </Button>
      )}

      {/* With simulations, desktop splits into content (left) + simulation
          rail (right); on smaller screens the rail stacks below as a section.
          While a simulation is open the columns flip: the summary shrinks
          into the narrow column and the simulation gets the rest of the page. */}
      <div
        className={cn(
          hasSimulations && "grid gap-6 lg:items-start",
          hasSimulations &&
            (simOpen
              ? "lg:grid-cols-[minmax(320px,26rem)_minmax(0,1fr)]"
              : "lg:grid-cols-[minmax(0,1fr)_minmax(320px,26rem)]")
        )}
      >
        <div className="min-w-0 space-y-6">
          {/* Unified header: the score banner (percentage only — no per-question
              count) and the AI summary live in one full-width card. */}
          <Card>
            <CardContent className="space-y-4 py-5">
              <ScoreBanner score={score} />
              <div className="border-t" />
              <ResultSummary
                summary={ai.summary}
                status={ai.summaryStatus}
                metrics={ai.summaryMetrics}
              />
            </CardContent>
          </Card>

          <StudentMistakesReview mistakes={mistakes} />

          {/* Holistic study recommendations — up to 3 cards chosen across the
              whole attempt, with NO per-question correctness or correct answers
              shown. */}
          <HolisticRecommendations
            recommendations={ai.recommendations}
            status={ai.recommendationsStatus}
            metrics={ai.recommendationMetrics}
          />
        </div>

        {/* Interactive topic simulations — question-detail-free by construction,
            so safe to show while the per-question review stays hidden. */}
        {hasSimulations && (
          <SimulationRail
            simulations={ai.simulations}
            attemptId={attemptId}
            activeId={activeSimId}
            onActiveChange={setActiveSimId}
          />
        )}
      </div>

      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}
