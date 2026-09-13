"use client";

import { useSyncExternalStore } from "react";
import { Atom, ChevronRight, CircleOff, X } from "lucide-react";
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
  type SimulationRecommendationView,
} from "@/lib/exam-results";

/**
 * Must match the `lg:` breakpoint of the results-page grid: below it the rail
 * renders as a stacked section and an active simulation opens full-screen; at
 * or above it the active simulation takes over the wide side of the grid.
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

const displayTitle = (sim: SimulationRecommendationView) =>
  sim.title ?? sim.topic ?? "Interactive simulation";

/**
 * Topic-switcher chips shown above an active simulation (both layouts).
 * Rendered only when there is more than one simulation to switch between.
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
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            )}
          >
            {displayTitle(sim)}
          </button>
        );
      })}
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
 * All simulations start collapsed (no physics loop boots with the page). The
 * active-simulation state is owned by the results page, because activating a
 * simulation on desktop flips the page grid so the simulation gets the whole
 * right side at full viewport height while the summary shrinks into the
 * narrow column; on mobile activation opens a full-screen dialog. Only one
 * iframe is ever mounted at a time.
 */
export function SimulationRail({
  simulations,
  attemptId,
  activeId,
  onActiveChange,
}: {
  simulations: SimulationRecommendationView[];
  /** Links telemetry sessions to the attempt whose results surfaced the sims. */
  attemptId?: string;
  /** Owned by the results page so it can widen this rail's grid column. */
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
}) {
  // Defensive render-time dedup: ExamResult snapshots are durable, so results
  // stored before generation-time dedup existed may still carry duplicates.
  const sims = dedupeStoredSimulations(simulations);
  // A ref whose simulation was deleted after the result was stored stays
  // listed as an unavailable card (never activatable), so the student sees
  // why it's gone instead of a dead iframe.
  const openable = sims.filter((sim) => !sim.unavailable);
  const isDesktop = useIsDesktop();

  if (sims.length === 0) return null;

  const active = openable.find((sim) => sim.simulationId === activeId) ?? null;

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
            onClick={() => onActiveChange(null)}
            aria-label="Close simulation"
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <SimulationChips sims={openable} activeId={active.simulationId} onSelect={onActiveChange} />
        <Card className="min-h-0 flex-1 overflow-hidden p-2">
          {/* Remount per simulation so switching restarts cleanly. */}
          <SimulationViewer
            key={`${active.simulationId}:${active.version ?? 0}`}
            simulationId={active.simulationId}
            title={displayTitle(active)}
            version={active.version}
            telemetry={attemptId ? { attemptId, surface: "rail" } : undefined}
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
        {sims.map((sim) =>
          sim.unavailable ? (
            <Card key={sim.simulationId} className="overflow-hidden border-dashed">
              <div className="flex w-full items-center justify-between gap-3 p-4">
                <span className="min-w-0">
                  <span className="block font-medium text-muted-foreground">
                    {displayTitle(sim)}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">
                    This simulation is no longer available.
                  </span>
                </span>
                <CircleOff aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </div>
            </Card>
          ) : (
            <Card key={sim.simulationId} className="overflow-hidden">
              <button
                type="button"
                onClick={() => onActiveChange(sim.simulationId)}
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
          )
        )}
      </div>

      {/* Mobile/tablet: the active simulation fills the screen. Rendered only
          below the desktop breakpoint — desktop activation is handled above. */}
      {active && !isDesktop && (
        <Dialog open onOpenChange={(open) => !open && onActiveChange(null)}>
          <DialogContent className="inset-0 left-0 top-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-0 p-0 sm:rounded-none">
            <DialogHeader className="space-y-2 border-b px-4 py-3 pr-12 text-left">
              <div>
                <DialogTitle className="text-base">{displayTitle(active)}</DialogTitle>
                {active.learningGoal ? (
                  <DialogDescription className="text-xs">{active.learningGoal}</DialogDescription>
                ) : (
                  <DialogDescription className="sr-only">Interactive simulation</DialogDescription>
                )}
              </div>
              <SimulationChips sims={openable} activeId={active.simulationId} onSelect={onActiveChange} />
            </DialogHeader>
            <div className="min-h-0 p-2">
              {/* Remount per simulation so switching restarts cleanly. */}
              <SimulationViewer
                key={`${active.simulationId}:${active.version ?? 0}`}
                simulationId={active.simulationId}
                title={displayTitle(active)}
                version={active.version}
                telemetry={attemptId ? { attemptId, surface: "mobile" } : undefined}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
