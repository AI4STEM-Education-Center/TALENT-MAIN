"use client";

import { useMemo, useState } from "react";
import { Atom, ChevronRight, FileQuestion } from "lucide-react";
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
import type {
  StudentSimulation,
  StudentSimulationClass,
} from "@/lib/student-content";

const ALL_CLASSES = "__all__";

interface SimulationsBrowserProps {
  classes: StudentSimulationClass[];
}

const displayTitle = (sim: StudentSimulation) =>
  sim.title ?? sim.topic ?? "Interactive simulation";

/**
 * The student's simulation library, grouped class -> quiz. Opening one mounts
 * a single sandboxed viewer in a full-screen dialog: simulations are physics
 * loops, so only ever one runs, and none boots until the student asks for it.
 */
export function SimulationsBrowser({ classes }: SimulationsBrowserProps) {
  const [classId, setClassId] = useState(ALL_CLASSES);
  const [activeId, setActiveId] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      classId === ALL_CLASSES
        ? classes
        : classes.filter((cls) => cls.classId === classId),
    [classes, classId],
  );

  const active = useMemo(() => {
    for (const cls of classes) {
      for (const quiz of cls.quizzes) {
        const sim = quiz.simulations.find((s) => s.id === activeId);
        if (sim) return sim;
      }
    }
    return null;
  }, [classes, activeId]);

  return (
    <div className="space-y-6">
      {classes.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {[{ classId: ALL_CLASSES, className: "All classes" }, ...classes].map(
            (cls) => (
              <button
                key={cls.classId}
                type="button"
                onClick={() => setClassId(cls.classId)}
                aria-pressed={classId === cls.classId}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  classId === cls.classId
                    ? "border-primary bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {cls.className}
              </button>
            ),
          )}
        </div>
      )}

      {visible.map((cls) => (
        <section
          key={cls.classId}
          className="space-y-4"
          aria-label={cls.className}
        >
          <h2 className="text-xl font-semibold">{cls.className}</h2>
          {cls.quizzes.map((quiz) => (
            <div key={`${cls.classId}:${quiz.quizId}`} className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <FileQuestion aria-hidden className="size-4" />
                {quiz.quizName}
                {quiz.topicName && (
                  <span className="opacity-70">· {quiz.topicName}</span>
                )}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {quiz.simulations.map((sim) => (
                  <Card key={sim.id} className="overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setActiveId(sim.id)}
                      className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/40"
                    >
                      <span className="flex min-w-0 items-start gap-3">
                        <Atom
                          aria-hidden
                          className="mt-0.5 size-4 shrink-0 text-primary"
                        />
                        <span className="min-w-0">
                          <span className="block font-medium">
                            {displayTitle(sim)}
                          </span>
                          {sim.learningGoal && (
                            <span className="mt-0.5 block text-sm text-muted-foreground">
                              {sim.learningGoal}
                            </span>
                          )}
                        </span>
                      </span>
                      <ChevronRight aria-hidden className="size-4 shrink-0" />
                    </button>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}

      {active && (
        <Dialog open onOpenChange={(open) => !open && setActiveId(null)}>
          <DialogContent className="inset-0 left-0 top-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none border-0 p-0 sm:rounded-none">
            <DialogHeader className="border-b px-4 py-3 pr-12 text-left">
              <DialogTitle className="text-base">
                {displayTitle(active)}
              </DialogTitle>
              {active.learningGoal ? (
                <DialogDescription className="text-xs">
                  {active.learningGoal}
                </DialogDescription>
              ) : (
                <DialogDescription className="sr-only">
                  Interactive simulation
                </DialogDescription>
              )}
            </DialogHeader>
            <div className="min-h-0 p-2">
              {/* Remount per simulation so switching restarts cleanly. */}
              <SimulationViewer
                key={`${active.id}:${active.version}`}
                simulationId={active.id}
                title={displayTitle(active)}
                version={active.version}
                telemetry={{ surface: "library" }}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
