"use client";

import { useMemo, useState } from "react";
import { Atom, ChevronRight, FileQuestion } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SimulationDialog } from "@/components/simulation/SimulationDialog";
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
 * a single sandboxed viewer in the shared SimulationDialog pop-up (sessions
 * labelled `library` and deliberately carrying no class, so library browsing
 * never shows up in instructor-facing class stats): simulations are physics
 * loops, so only ever one runs, and none boots until the student asks for it.
 */
export function SimulationsBrowser({ classes }: SimulationsBrowserProps) {
  const [classId, setClassId] = useState(ALL_CLASSES);
  // Keyed by class too: a quiz assigned to two of the student's classes lists
  // the same simulation under both, and the pop-up names the class it was
  // opened under (display only — the session itself records no class).
  const [activeKey, setActiveKey] = useState<{
    classId: string;
    simId: string;
  } | null>(null);

  const visible = useMemo(
    () =>
      classId === ALL_CLASSES
        ? classes
        : classes.filter((cls) => cls.classId === classId),
    [classes, classId],
  );

  const active = useMemo(() => {
    if (!activeKey) return null;
    const cls = classes.find((c) => c.classId === activeKey.classId);
    for (const quiz of cls?.quizzes ?? []) {
      const sim = quiz.simulations.find((s) => s.id === activeKey.simId);
      if (cls && sim) return { cls, quiz, sim };
    }
    return null;
  }, [classes, activeKey]);

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
                      onClick={() =>
                        setActiveKey({ classId: cls.classId, simId: sim.id })
                      }
                      aria-haspopup="dialog"
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
        <SimulationDialog
          simulation={{
            simulationId: active.sim.id,
            title: displayTitle(active.sim),
            version: active.sim.version,
          }}
          onClose={() => setActiveKey(null)}
          description={active.sim.learningGoal}
          context={[active.quiz.quizName, active.cls.className].join(" · ")}
          telemetry={{ surface: "library" }}
        />
      )}
    </div>
  );
}
