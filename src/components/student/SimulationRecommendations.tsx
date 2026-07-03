"use client";

import { useState } from "react";
import { Atom, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SimulationViewer } from "@/components/simulation/SimulationViewer";
import type { StoredSimulationRecommendation } from "@/lib/exam-results";

/**
 * Student-facing interactive simulations surfaced with the post-quiz
 * recommendations. Like the material cards, these carry NO per-question
 * framing — each simulation teaches a broad topic from the quiz (that
 * constraint is enforced when the simulation is generated), so nothing here
 * hints at which answers were right or wrong beyond the topics to revisit.
 * The first simulation starts open; the rest expand on demand so the page
 * doesn't boot several physics loops at once.
 */
export function SimulationRecommendations({
  simulations,
}: {
  simulations: StoredSimulationRecommendation[];
}) {
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(simulations.slice(0, 1).map((s) => s.simulationId))
  );

  if (simulations.length === 0) return null;

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-1.5 text-lg font-semibold">
        <Atom className="size-5 text-primary" /> Explore with simulations
      </h2>
      <p className="text-sm text-muted-foreground">
        Interactive simulations of topics from this quiz — change the parameters and watch what
        happens.
      </p>
      <div className="space-y-3">
        {simulations.map((sim) => {
          const isOpen = open.has(sim.simulationId);
          const title = sim.title ?? sim.topic ?? "Interactive simulation";
          return (
            <Card key={sim.simulationId} className="overflow-hidden">
              <button
                type="button"
                onClick={() => toggle(sim.simulationId)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/40"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{title}</span>
                  {sim.learningGoal && (
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {sim.learningGoal}
                    </span>
                  )}
                </span>
                {isOpen ? (
                  <ChevronDown className="size-4 shrink-0" />
                ) : (
                  <ChevronRight className="size-4 shrink-0" />
                )}
              </button>
              {isOpen && (
                <div className="h-[28rem] border-t p-2 sm:h-[32rem]">
                  <SimulationViewer simulationId={sim.simulationId} title={title} />
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
