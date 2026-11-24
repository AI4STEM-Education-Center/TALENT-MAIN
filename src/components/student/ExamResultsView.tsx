"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MyFeedbackProvider } from "@/components/feedback/my-feedback";
import { isResultPending, type StudentMistakeView } from "@/lib/exam-results";
import type { CoachEligibilityItem } from "@/lib/wrong-answer-coach-types";
import type { ResourceSurface } from "@/lib/resource-telemetry";
import type { SimulationSurface } from "@/lib/simulation-telemetry";
import { CoachStep } from "./post-quiz/CoachStep";
import { QuietExitLinks, StepProgress } from "./post-quiz/GuidedChrome";
import {
  CompleteStep,
  MaterialsStep,
  SimulationsStep,
  SummaryStep,
} from "./post-quiz/GuidedSteps";
import {
  ADVANCE_LABEL,
  guidedSteps,
  nextStep,
  type GuidedStepId,
} from "./post-quiz/guided-steps";
import {
  useStreamedResults,
  type AiState,
} from "./post-quiz/use-streamed-results";

/** The learning-resource surface label for each results view. */
const RESOURCE_SURFACE_FOR: Record<
  "quiz_results" | "results_page",
  ResourceSurface
> = {
  quiz_results: "results_recommendation",
  results_page: "history_recommendation",
};

/** A Set with one more member, as a new object (state stays immutable). */
const withMember = <T,>(set: ReadonlySet<T>, value: T): Set<T> =>
  set.has(value) ? (set as Set<T>) : new Set([...set, value]);

/**
 * The post-quiz results as a guided, step-by-step review: Summary → each
 * missed question with the coach → simulations → learning materials →
 * complete. Steps with nothing in them are left out; quiet links on every
 * step let the student skip to the end or leave.
 */
export function ExamResultsView({
  attemptId,
  score,
  mistakes,
  initial,
  backHref,
  backLabel = "Back",
  actions,
  notice,
  simulationSurface,
}: {
  attemptId: string;
  score: number;
  mistakes: StudentMistakeView[];
  initial: AiState;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
  /** Context line above the score, e.g. which alternative version this was. */
  notice?: ReactNode;
  /**
   * Which results view this is, so simulation sessions opened from it are
   * labelled with their launch point: `quiz_results` right after submitting,
   * `results_page` when a past attempt is reopened. Recommended-material
   * opens are labelled from the same value (see RESOURCE_SURFACE_FOR).
   */
  simulationSurface: Extract<
    SimulationSurface,
    "quiz_results" | "results_page"
  >;
}) {
  const ai = useStreamedResults(attemptId, initial);
  const recsPending = isResultPending(ai.recommendationsStatus);

  const [coachEligibility, setCoachEligibility] = useState<
    Record<number, CoachEligibilityItem>
  >({});
  const loadCoachEligibility = useCallback(async () => {
    if (!attemptId || mistakes.length === 0) return;
    try {
      const res = await fetch(
        `/api/student/attempts/${attemptId}/coach-eligibility`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { items?: CoachEligibilityItem[] };
      if (!Array.isArray(data.items)) return;
      const next: Record<number, CoachEligibilityItem> = {};
      for (const item of data.items) {
        next[item.questionNumber] = item;
      }
      setCoachEligibility(next);
    } catch {
      // Best-effort: never disrupt the results page if eligibility fails.
    }
  }, [attemptId, mistakes.length]);

  useEffect(() => {
    void loadCoachEligibility();
  }, [loadCoachEligibility]);

  const [active, setActive] = useState<GuidedStepId>("summary");
  const [visited, setVisited] = useState<ReadonlySet<GuidedStepId>>(
    () => new Set<GuidedStepId>(["summary"]),
  );
  const [mistakeIndex, setMistakeIndex] = useState(0);
  const [engaged, setEngaged] = useState<ReadonlySet<number>>(() => new Set());
  const [explored, setExplored] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set());
  const topRef = useRef<HTMLDivElement>(null);

  const steps = guidedSteps({
    mistakeCount: mistakes.length,
    simulationCount: ai.simulations.length,
    recommendationCount: ai.recommendations.length,
    recommendationsPending: recsPending,
    active,
  });

  const goTo = (step: GuidedStepId) => {
    setActive(step);
    setVisited((prev) => withMember(prev, step));
    topRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };
  const advance = () => goTo(nextStep(steps, active) ?? "complete");
  const nextLabel = ADVANCE_LABEL[nextStep(steps, active) ?? "complete"];

  const markEngaged = useCallback(
    (questionNumber: number) =>
      setEngaged((prev) => withMember(prev, questionNumber)),
    [],
  );

  const stepBody = (() => {
    switch (active) {
      case "summary":
        return (
          <SummaryStep
            score={score}
            notice={notice}
            summary={ai.summary}
            summaryStatus={ai.summaryStatus}
            summaryMetrics={ai.summaryMetrics}
            mistakeCount={mistakes.length}
            simulationCount={ai.simulations.length}
            recommendationCount={ai.recommendations.length}
            recommendationsPending={recsPending}
            nextLabel={nextLabel}
            onNext={advance}
          />
        );
      case "coach":
        return mistakes.length > 0 ? (
          <CoachStep
            attemptId={attemptId}
            mistakes={mistakes}
            index={Math.min(mistakeIndex, mistakes.length - 1)}
            onIndexChange={(index) => {
              setMistakeIndex(index);
              topRef.current?.scrollIntoView?.({ block: "start" });
            }}
            engaged={engaged}
            onEngaged={markEngaged}
            coachEligibility={coachEligibility}
            onCoachStateChange={loadCoachEligibility}
            nextLabel={nextLabel}
            onFinish={advance}
          />
        ) : null;
      case "simulations":
        return (
          <SimulationsStep
            attemptId={attemptId}
            simulations={ai.simulations}
            pending={recsPending}
            surface={simulationSurface}
            explored={explored}
            onExplore={(id) => setExplored((prev) => withMember(prev, id))}
            nextLabel={nextLabel}
            onNext={advance}
          />
        );
      case "materials":
        return (
          <MaterialsStep
            attemptId={attemptId}
            recommendations={ai.recommendations}
            status={ai.recommendationsStatus}
            metrics={ai.recommendationMetrics}
            surface={RESOURCE_SURFACE_FOR[simulationSurface]}
            viewed={viewed}
            onView={(key) => setViewed((prev) => withMember(prev, key))}
            nextLabel={nextLabel}
            onNext={advance}
          />
        );
      case "complete":
        return (
          <CompleteStep
            stats={{
              summarySeen: visited.has("summary"),
              mistakeCount: mistakes.length,
              coachedCount: mistakes.filter((m) =>
                engaged.has(m.questionNumber),
              ).length,
              simulationCount: ai.simulations.length,
              exploredCount: explored.size,
              recommendationCount: ai.recommendations.length,
              viewedCount: viewed.size,
            }}
            steps={steps}
            onRevisit={goTo}
            actions={actions}
          />
        );
    }
  })();

  return (
    /* One lookup of "what have I already rated on this attempt", shared by
       every material card and simulation below — otherwise each of them
       would fetch the same list on mount. */
    <MyFeedbackProvider attemptId={attemptId}>
      <div ref={topRef} className="max-w-6xl scroll-mt-4 space-y-6 p-4 md:p-6">
        <StepProgress
          steps={steps}
          active={active}
          visited={visited}
          onSelect={goTo}
        />

        {stepBody}

        <QuietExitLinks
          onSkipToEnd={
            active === "complete" ? undefined : () => goTo("complete")
          }
          backHref={backHref}
          backLabel={backLabel}
        />
      </div>
    </MyFeedbackProvider>
  );
}
