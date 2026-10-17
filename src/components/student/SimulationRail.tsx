"use client";

import { useState } from "react";
import { Atom, ChevronRight, CircleOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SimulationDialog } from "@/components/simulation/SimulationDialog";
import { FeedbackRatingForm } from "@/components/feedback/FeedbackRatingForm";
import { cn } from "@/lib/utils";
import {
  dedupeStoredSimulations,
  type SimulationRecommendationView,
} from "@/lib/exam-results";
import type { SimulationSurface } from "@/lib/simulation-telemetry";

const displayTitle = (sim: SimulationRecommendationView) =>
  sim.title ?? sim.topic ?? "Interactive simulation";

/** The broad topic, when the title doesn't already say it. */
const topicContext = (sim: SimulationRecommendationView) =>
  sim.topic && sim.title && sim.topic.trim() !== sim.title.trim()
    ? `Topic: ${sim.topic}`
    : null;

/**
 * Topic-switcher chips in the open simulation's header. Rendered only when
 * there is more than one simulation to switch between.
 */
function SimulationChips({
  sims,
  activeId,
  onSelect,
}: {
  sims: SimulationRecommendationView[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  if (sims.length < 2) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {sims.map((sim) => {
        const isActive = sim.simulationId === activeId;
        return (
          <button
            key={sim.simulationId}
            type="button"
            onClick={() => onSelect(sim.simulationId)}
            aria-pressed={isActive}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              isActive
                ? "border-primary bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            {displayTitle(sim)}
          </button>
        );
      })}
    </div>
  );
}

/** Which viewer this rail is: whose ratings, and whether sessions are logged. */
type ViewerSettings = {
  attemptId?: string;
  audience: "student" | "teacher";
};

/**
 * The rating under an OPEN simulation (the pop-up's footer).
 *
 * Deliberately not on the collapsed cards: a verdict on something nobody has
 * run yet is noise, and asking once it has actually been played with is when
 * there is an answer to give. Both audiences rate — the student on their own
 * results, the teacher on the copy in that student's stats — so the Feedback
 * panel can show the two side by side. They are asked different questions,
 * because only the teacher can judge whether the topic was the right call.
 */
function SimulationRating({
  sim,
  viewer,
}: {
  sim: SimulationRecommendationView;
  viewer: ViewerSettings;
}) {
  if (!viewer.attemptId) return null;
  const forTeacher = viewer.audience === "teacher";
  return (
    <FeedbackRatingForm
      subjectType="SIMULATION"
      subjectId={sim.simulationId}
      subjectLabel={displayTitle(sim)}
      subjectDetail={sim.learningGoal ?? sim.topic}
      attemptId={viewer.attemptId}
      prompt={
        forTeacher
          ? "Was this a good simulation to recommend here?"
          : "Was this simulation useful?"
      }
      commentPlaceholder={
        forTeacher
          ? "In a sentence or two — was this the right topic for this student, and does the simulation teach it correctly?"
          : "In a sentence or two — what did it help you see, or what was confusing?"
      }
    />
  );
}

/** The collapsed list. Nothing here boots an iframe. */
function SimulationCardList({
  sims,
  onActivate,
}: {
  sims: SimulationRecommendationView[];
  onActivate: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      {sims.map((sim) =>
        sim.unavailable ? (
          <Card
            key={sim.simulationId}
            className="overflow-hidden border-dashed"
          >
            <div className="flex w-full items-center justify-between gap-3 p-4">
              <span className="min-w-0">
                <span className="block font-medium text-muted-foreground">
                  {displayTitle(sim)}
                </span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  This simulation is no longer available.
                </span>
              </span>
              <CircleOff
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
            </div>
          </Card>
        ) : (
          <Card key={sim.simulationId} className="overflow-hidden">
            <button
              type="button"
              onClick={() => onActivate(sim.simulationId)}
              aria-haspopup="dialog"
              className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/40"
            >
              <span className="min-w-0">
                <span className="block font-medium">{displayTitle(sim)}</span>
                {sim.learningGoal && (
                  <span className="mt-0.5 block text-sm text-muted-foreground">
                    {sim.learningGoal}
                  </span>
                )}
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0" />
            </button>
          </Card>
        ),
      )}
    </div>
  );
}

/**
 * Interactive simulations surfaced with post-quiz recommendations for the
 * student and their authorized teacher. Like the material cards, these carry
 * NO per-question framing — each simulation teaches a broad topic from the quiz
 * (that constraint is enforced when the simulation is generated), so nothing
 * here hints at which answers were right or wrong beyond the topics to revisit.
 *
 * All simulations start collapsed (no physics loop boots with the page).
 * Opening one launches it in the shared SimulationDialog pop-up, on every
 * screen size, with the rating form in the pop-up's footer. Only one iframe is
 * ever mounted at a time, and the page layout never changes around it.
 */
export function SimulationRail({
  simulations,
  attemptId,
  telemetrySurface,
  audience = "student",
}: {
  simulations: SimulationRecommendationView[];
  /** The attempt whose results surfaced these sims. Enables the rating form. */
  attemptId?: string;
  /**
   * Opt in to engagement telemetry, labelled with this launch surface.
   * Separate from `attemptId` on purpose: the teacher's copy of this rail
   * (student stats) needs the attempt id to rate the recommendation, but must
   * NOT record sessions — SimulationSession rows are student engagement
   * signal, and a teacher browsing the same simulation would show up as a
   * student who studied it.
   */
  telemetrySurface?: SimulationSurface;
  /** Picks the rating wording: rating your own study aid vs. a student's. */
  audience?: "student" | "teacher";
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Defensive render-time dedup: ExamResult snapshots are durable, so results
  // stored before generation-time dedup existed may still carry duplicates.
  const sims = dedupeStoredSimulations(simulations);
  // A ref whose simulation was deleted after the result was stored stays
  // listed as an unavailable card (never activatable), so the student sees
  // why it's gone instead of a dead iframe.
  const openable = sims.filter((sim) => !sim.unavailable);

  if (sims.length === 0) return null;

  const active = openable.find((sim) => sim.simulationId === activeId) ?? null;
  const viewer = { attemptId, audience } as const;

  return (
    <section
      aria-label="Explore with simulations"
      className="space-y-3 lg:sticky lg:top-4"
    >
      <h2 className="flex items-center gap-1.5 text-lg font-semibold">
        <Atom className="size-5 text-primary" /> Explore with simulations
      </h2>
      <p className="text-sm text-muted-foreground">
        Interactive simulations of topics from this quiz — change the parameters
        and watch what happens.
      </p>
      <SimulationCardList sims={sims} onActivate={setActiveId} />

      {active && (
        <SimulationDialog
          simulation={{
            simulationId: active.simulationId,
            title: displayTitle(active),
            version: active.version,
          }}
          onClose={() => setActiveId(null)}
          description={active.learningGoal}
          context={topicContext(active)}
          headerExtra={
            <SimulationChips
              sims={openable}
              activeId={active.simulationId}
              onSelect={setActiveId}
            />
          }
          footer={
            attemptId ? (
              <SimulationRating sim={active} viewer={viewer} />
            ) : undefined
          }
          telemetry={
            telemetrySurface && attemptId
              ? { attemptId, surface: telemetrySurface }
              : undefined
          }
        />
      )}
    </section>
  );
}
