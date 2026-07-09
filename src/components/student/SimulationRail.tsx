"use client";

import { useState, useSyncExternalStore } from "react";
import { Atom, ChevronRight, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SimulationViewer } from "@/components/simulation/SimulationViewer";
import { cn } from "@/lib/utils";
import {
  dedupeStoredSimulations,
  type StoredSimulationRecommendation,
} from "@/lib/exam-results";

/**
 * Must match the `lg:` breakpoint of the results-page grid: below it the rail
 * renders as a stacked section and an active simulation opens full-screen; at
 * or above it the active simulation takes over the whole right column.
 */
const DESKTOP_QUERY = "(min-width: 1024px)";

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(DESKTOP_QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    // Server render: nothing is active yet, so both layouts render the same
    // collapsed list and the fallback value never causes a hydration mismatch.
    () => false
  );
}

const displayTitle = (sim: StoredSimulationRecommendation) =>
  sim.title ?? sim.topic ?? "Interactive simulation";

/**
 * Student-facing interactive simulations surfaced with the post-quiz
 * recommendations. Like the material cards, these carry NO per-question
 * framing — each simulation teaches a broad topic from the quiz (that
 * constraint is enforced when the simulation is generated), so nothing here
 * hints at which answers were right or wrong beyond the topics to revisit.
 *
 * All simulations start collapsed (no physics loop boots with the page). On
 * desktop the list lives in the results page's right column and an activated
 * simulation expands to fill that entire column; on mobile activation opens a
 * full-screen dialog. Only one iframe is ever mounted at a time.
 */
export function SimulationRail({
  simulations,
  attemptId,
}: {
  simulations: StoredSimulationRecommendation[];
  /** Links telemetry sessions to the attempt whose results surfaced the sims. */
  attemptId?: string;
}) {
  // Defensive render-time dedup: ExamResult snapshots are durable, so results
  // stored before generation-time dedup existed may still carry duplicates.
  const sims = dedupeStoredSimulations(simulations);
  const [activeId, setActiveId] = useState<string | null>(null);
  const isDesktop = useIsDesktop();

  if (sims.length === 0) return null;

  const active = sims.find((sim) => sim.simulationId === activeId) ?? null;

  if (isDesktop && active) {
    return (
      <section
        aria-label="Explore with simulations"
        className="flex h-[calc(100dvh-7rem)] flex-col gap-2 lg:sticky lg:top-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-lg font-semibold">
              <Atom className="size-5 shrink-0 text-primary" />
              <span className="truncate">{displayTitle(active)}</span>
            </h2>
            {active.learningGoal && (
              <p className="mt-0.5 text-sm text-muted-foreground">{active.learningGoal}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setActiveId(null)}
            aria-label="Close simulation"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        {sims.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {sims.map((sim) => {
              const isActive = sim.simulationId === active.simulationId;
              return (
                <button
                  key={sim.simulationId}
                  type="button"
                  onClick={() => setActiveId(sim.simulationId)}
                  aria-pressed={isActive}
                  className={cn(
                    "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  )}
                >
                  {displayTitle(sim)}
                </button>
              );
            })}
          </div>
        )}
        <Card className="min-h-0 flex-1 overflow-hidden p-2">
          {/* Remount per simulation so switching restarts cleanly. */}
          <SimulationViewer
            key={active.simulationId}
            simulationId={active.simulationId}
            title={displayTitle(active)}
            telemetry={{ attemptId, surface: "rail" }}
          />
        </Card>
      </section>
    );
  }

  return (
    <section aria-label="Explore with simulations" className="space-y-3 lg:sticky lg:top-4">
      <h2 className="flex items-center gap-1.5 text-lg font-semibold">
        <Atom className="size-5 text-primary" /> Explore with simulations
      </h2>
      <p className="text-sm text-muted-foreground">
        Interactive simulations of topics from this quiz — change the parameters and watch what
        happens.
      </p>
      <div className="space-y-3">
        {sims.map((sim) => (
          <Card key={sim.simulationId} className="overflow-hidden">
            <button
              type="button"
              onClick={() => setActiveId(sim.simulationId)}
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
              <ChevronRight className="size-4 shrink-0" />
            </button>
          </Card>
        ))}
      </div>

      {/* Mobile/tablet: the active simulation fills the screen. Rendered only
          below the desktop breakpoint — desktop activation is handled above. */}
      {active && !isDesktop && (
        <Dialog open onOpenChange={(open) => !open && setActiveId(null)}>
          <DialogContent className="inset-0 left-0 top-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-0 p-0 sm:rounded-none">
            <DialogHeader className="space-y-0.5 border-b px-4 py-3 pr-12 text-left">
              <DialogTitle className="text-base">{displayTitle(active)}</DialogTitle>
              {active.learningGoal ? (
                <DialogDescription className="text-xs">{active.learningGoal}</DialogDescription>
              ) : (
                <DialogDescription className="sr-only">Interactive simulation</DialogDescription>
              )}
            </DialogHeader>
            <div className="min-h-0 p-2">
              <SimulationViewer
                simulationId={active.simulationId}
                title={displayTitle(active)}
                telemetry={{ attemptId, surface: "mobile" }}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
