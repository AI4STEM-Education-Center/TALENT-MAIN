"use client";

import type { ReactNode } from "react";
import {
  Atom,
  BookOpen,
  CheckCircle2,
  Circle,
  ClipboardList,
  Loader2,
  MessageCircleQuestion,
  PartyPopper,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ScoreBanner } from "@/components/student/QuizReviewResult";
import { ResultSummary } from "@/components/results/ResultSummary";
import { HolisticRecommendations } from "@/components/student/HolisticRecommendations";
import { SimulationRail } from "@/components/student/SimulationRail";
import type {
  PresignedRecommendation,
  ResultComponentMetrics,
  ResultStatus,
  SimulationRecommendationView,
} from "@/lib/exam-results";
import type { ResourceSurface } from "@/lib/resource-telemetry";
import type { SimulationSurface } from "@/lib/simulation-telemetry";
import { AdvanceButton, StepHeader } from "./GuidedChrome";
import type { GuidedStepId } from "./guided-steps";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function StepFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-3">{children}</div>;
}

function OverviewItem({
  icon,
  title,
  detail,
}: {
  icon: ReactNode;
  title: string;
  detail: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 rounded-lg border bg-background/60 p-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
}

function Pending({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Loader2 className="size-3 animate-spin" aria-hidden /> {children}
    </span>
  );
}

/** Step 1: how it went, the AI summary, and what the review will cover. */
export function SummaryStep({
  score,
  notice,
  summary,
  summaryStatus,
  summaryMetrics,
  mistakeCount,
  simulationCount,
  recommendationCount,
  recommendationsPending,
  nextLabel,
  onNext,
}: {
  score: number;
  notice?: ReactNode;
  summary: string | null;
  summaryStatus: ResultStatus;
  summaryMetrics: ResultComponentMetrics | null;
  mistakeCount: number;
  simulationCount: number;
  recommendationCount: number;
  recommendationsPending: boolean;
  nextLabel: string;
  onNext: () => void;
}) {
  return (
    <section aria-label="Summary" className="space-y-5">
      <Card>
        <CardContent className="space-y-4 py-5">
          {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
          <ScoreBanner score={score} />
          <div className="border-t" />
          <ResultSummary
            summary={summary}
            status={summaryStatus}
            metrics={summaryMetrics}
          />
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Your guided review</h2>
        <ul className="grid gap-2 sm:grid-cols-3">
          <OverviewItem
            icon={<MessageCircleQuestion className="size-4" aria-hidden />}
            title="Missed questions"
            detail={
              mistakeCount > 0
                ? `${plural(mistakeCount, "question")} to talk through with the coach`
                : "None — you answered everything correctly"
            }
          />
          <OverviewItem
            icon={<Atom className="size-4" aria-hidden />}
            title="Simulations"
            detail={
              recommendationsPending && simulationCount === 0 ? (
                <Pending>Finding simulations…</Pending>
              ) : simulationCount > 0 ? (
                `${plural(simulationCount, "interactive simulation")} to explore`
              ) : (
                "None for this quiz"
              )
            }
          />
          <OverviewItem
            icon={<BookOpen className="size-4" aria-hidden />}
            title="Learning materials"
            detail={
              recommendationsPending && recommendationCount === 0 ? (
                <Pending>Choosing pages for you…</Pending>
              ) : recommendationCount > 0 ? (
                `${plural(recommendationCount, "recommended reading")}`
              ) : (
                "None for this quiz"
              )
            }
          />
        </ul>
      </div>

      <StepFooter>
        <AdvanceButton label={nextLabel} onClick={onNext} />
      </StepFooter>
    </section>
  );
}

/** Step 3: the recommended simulations, launched one at a time in a pop-up. */
export function SimulationsStep({
  attemptId,
  simulations,
  pending,
  surface,
  explored,
  onExplore,
  nextLabel,
  onNext,
}: {
  attemptId: string;
  simulations: SimulationRecommendationView[];
  pending: boolean;
  surface: SimulationSurface;
  explored: ReadonlySet<string>;
  onExplore: (simulationId: string) => void;
  nextLabel: string;
  onNext: () => void;
}) {
  return (
    <section aria-label="Interactive simulations" className="space-y-5">
      <StepHeader
        icon={<Atom className="size-5 text-primary" aria-hidden />}
        title="Explore with simulations"
      >
        Interactive simulations of topics from this quiz. Open one, change the
        parameters and watch what happens — then rate it so we can recommend
        better ones.
      </StepHeader>

      {simulations.length > 0 ? (
        <SimulationRail
          key={attemptId}
          simulations={simulations}
          attemptId={attemptId}
          telemetrySurface={surface}
          onOpen={onExplore}
          exploredIds={explored}
          showHeading={false}
        />
      ) : pending ? (
        <div
          className="space-y-3"
          role="status"
          aria-label="Loading simulations"
        >
          {[0, 1].map((n) => (
            <div
              key={n}
              className="h-16 animate-pulse rounded-xl border bg-muted/40"
            />
          ))}
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" /> Finding
            simulations for this quiz…
          </p>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          No simulations for this quiz — you can carry on.
        </p>
      )}

      {simulations.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {explored.size} of {simulations.length} explored
        </p>
      )}

      <StepFooter>
        <AdvanceButton label={nextLabel} onClick={onNext} />
      </StepFooter>
    </section>
  );
}

/** Step 4: the recommended course-material pages. */
export function MaterialsStep({
  attemptId,
  recommendations,
  status,
  metrics,
  surface,
  viewed,
  onView,
  nextLabel,
  onNext,
}: {
  attemptId: string;
  recommendations: PresignedRecommendation[];
  status: ResultStatus;
  metrics: ResultComponentMetrics | null;
  surface: ResourceSurface;
  viewed: ReadonlySet<string>;
  onView: (key: string) => void;
  nextLabel: string;
  onNext: () => void;
}) {
  return (
    <section aria-label="Recommended learning materials" className="space-y-5">
      <StepHeader
        icon={<BookOpen className="size-5 text-primary" aria-hidden />}
        title="Recommended learning materials"
      >
        Pages from your course materials picked for what to study next. Open a
        card to read them full size.
      </StepHeader>

      <HolisticRecommendations
        recommendations={recommendations}
        status={status}
        metrics={metrics}
        attemptId={attemptId}
        telemetrySurface={surface}
        onOpen={onView}
        viewedKeys={viewed}
        showHeading={false}
      />

      <StepFooter>
        <AdvanceButton label={nextLabel} onClick={onNext} />
      </StepFooter>
    </section>
  );
}

function DoneRow({
  done,
  label,
  detail,
  onRevisit,
}: {
  done: boolean;
  label: string;
  detail: string;
  onRevisit?: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      {done ? (
        <CheckCircle2
          className="size-5 shrink-0 text-green-600 dark:text-green-400"
          aria-hidden
        />
      ) : (
        <Circle
          className="size-5 shrink-0 text-muted-foreground/50"
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
      {onRevisit && (
        <button
          type="button"
          onClick={onRevisit}
          className="shrink-0 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          Revisit
        </button>
      )}
    </li>
  );
}

export type CompletionStats = {
  summarySeen: boolean;
  mistakeCount: number;
  coachedCount: number;
  simulationCount: number;
  exploredCount: number;
  recommendationCount: number;
  viewedCount: number;
};

/** Step 5: what was covered, a way back to any step, and what to do next. */
export function CompleteStep({
  stats,
  steps,
  onRevisit,
  actions,
}: {
  stats: CompletionStats;
  steps: GuidedStepId[];
  onRevisit: (step: GuidedStepId) => void;
  actions?: ReactNode;
}) {
  const has = (step: GuidedStepId) => steps.includes(step);
  return (
    <section aria-label="Review complete" className="space-y-5">
      <Card>
        <CardContent className="space-y-4 py-6">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <PartyPopper className="size-5" aria-hidden />
            </span>
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                Review complete
              </h2>
              <p className="text-sm text-muted-foreground">
                Nice work. Here&apos;s what you covered — revisit anything you
                want before moving on.
              </p>
            </div>
          </div>

          <ul className="divide-y rounded-lg border px-3">
            <DoneRow
              done={stats.summarySeen}
              label="Summary reviewed"
              detail="Your score and the AI summary of this attempt"
              onRevisit={() => onRevisit("summary")}
            />
            {has("coach") && (
              <DoneRow
                done={
                  stats.mistakeCount > 0 &&
                  stats.coachedCount >= stats.mistakeCount
                }
                label={`${stats.coachedCount}/${stats.mistakeCount} missed questions coached`}
                detail="Talked through with the coach"
                onRevisit={() => onRevisit("coach")}
              />
            )}
            {has("simulations") && (
              <DoneRow
                done={stats.exploredCount > 0}
                label={`${stats.exploredCount}/${stats.simulationCount} simulations explored`}
                detail="Interactive simulations of this quiz's topics"
                onRevisit={() => onRevisit("simulations")}
              />
            )}
            {has("materials") && (
              <DoneRow
                done={stats.viewedCount > 0}
                label={`${stats.viewedCount}/${stats.recommendationCount} materials viewed`}
                detail="Recommended pages from your course materials"
                onRevisit={() => onRevisit("materials")}
              />
            )}
          </ul>
        </CardContent>
      </Card>

      {actions && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <ClipboardList className="size-4 text-primary" aria-hidden /> Next
            steps
          </h3>
          <div className="flex flex-wrap gap-3">{actions}</div>
        </div>
      )}
    </section>
  );
}
