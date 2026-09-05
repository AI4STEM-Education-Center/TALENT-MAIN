"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ResultSummary } from "@/components/results/ResultSummary";
import { HolisticRecommendations } from "@/components/student/HolisticRecommendations";
import { SimulationRail } from "@/components/student/SimulationRail";
import { MyFeedbackProvider } from "@/components/feedback/my-feedback";
import { useContentFullWidth } from "@/components/dashboard/content-width";
import { cn } from "@/lib/utils";
import type {
  PresignedRecommendation,
  ResultComponentMetrics,
  ResultStatus,
  SimulationRecommendationView,
} from "@/lib/exam-results";

/**
 * Teacher-facing copy of every learning resource attached to a durable result:
 * the generated next steps, every recommended slide, and every simulation.
 *
 * The teacher rates these too. They are the only person who can say whether a
 * recommendation was APPROPRIATE — a student can report that pages did not
 * help them, but not that the generator picked the wrong topic for where they
 * are — so their verdict sits next to the student's in the Feedback panel.
 * Ratings here are TEACHER-audience rows; engagement telemetry stays off (see
 * `recordTelemetry` on SimulationRail), because a teacher reviewing a
 * simulation is not a student studying it.
 */
export function TeacherAttemptResources({
  attemptId,
  summary,
  summaryStatus,
  summaryMetrics,
  recommendations,
  recommendationsStatus,
  recommendationMetrics,
  simulations,
}: {
  /** The attempt these resources belong to; enables the teacher's ratings. */
  attemptId: string;
  summary: string | null;
  summaryStatus: ResultStatus;
  summaryMetrics: ResultComponentMetrics | null;
  recommendations: PresignedRecommendation[];
  recommendationsStatus: ResultStatus;
  recommendationMetrics: ResultComponentMetrics | null;
  simulations: SimulationRecommendationView[];
}) {
  const [activeSimId, setActiveSimId] = useState<string | null>(null);
  const hasSimulations = simulations.length > 0;
  const simOpen = activeSimId !== null;

  useContentFullWidth(simOpen);

  return (
    /* One lookup of this teacher's existing ratings for the attempt, shared by
       the material cards and the simulation rail below. */
    <MyFeedbackProvider attemptId={attemptId}>
      <section
        aria-label="Recommended learning resources"
        className={cn(
          simOpen ? "max-w-none" : hasSimulations ? "max-w-7xl" : "max-w-6xl",
        )}
      >
        <div
          className={cn(
            hasSimulations && "grid gap-6 lg:items-start",
            hasSimulations &&
              (simOpen
                ? "lg:grid-cols-[minmax(320px,26rem)_minmax(0,1fr)]"
                : "lg:grid-cols-[minmax(0,1fr)_minmax(320px,26rem)]"),
          )}
        >
          <div className="min-w-0 space-y-6">
            <Card>
              <CardContent className="py-5">
                <ResultSummary
                  summary={summary}
                  status={summaryStatus}
                  metrics={summaryMetrics}
                />
              </CardContent>
            </Card>

            <HolisticRecommendations
              recommendations={recommendations}
              status={recommendationsStatus}
              metrics={recommendationMetrics}
              audience="teacher"
              attemptId={attemptId}
            />
          </div>

          {hasSimulations && (
            <SimulationRail
              simulations={simulations}
              attemptId={attemptId}
              audience="teacher"
              activeId={activeSimId}
              onActiveChange={setActiveSimId}
            />
          )}
        </div>
      </section>
    </MyFeedbackProvider>
  );
}
