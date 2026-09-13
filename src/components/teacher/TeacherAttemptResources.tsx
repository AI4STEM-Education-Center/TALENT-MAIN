"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ResultSummary } from "@/components/results/ResultSummary";
import { HolisticRecommendations } from "@/components/student/HolisticRecommendations";
import { SimulationRail } from "@/components/student/SimulationRail";
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
 */
export function TeacherAttemptResources({
  summary,
  summaryStatus,
  summaryMetrics,
  recommendations,
  recommendationsStatus,
  recommendationMetrics,
  simulations,
}: {
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
          />
        </div>

        {hasSimulations && (
          <SimulationRail
            simulations={simulations}
            activeId={activeSimId}
            onActiveChange={setActiveSimId}
          />
        )}
      </div>
    </section>
  );
}
