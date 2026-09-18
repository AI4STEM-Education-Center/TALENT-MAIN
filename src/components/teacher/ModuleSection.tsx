import { Plus, ArrowUp, ArrowDown, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

import type { QuizModule } from "@/lib/class-modules";
import type { ModuleOrganizerState } from "./useModuleOrganizer";
import { ModuleQuizRow } from "./ModuleQuizRow";
export function ModuleSection({
  organizer,
  module,
  moduleIndex,
}: {
  organizer: ModuleOrganizerState;
  module: QuizModule;
  moduleIndex: number;
}) {
  const {
    byId,
    search,
    topic,
    collapsed,
    over,
    hover,
    hoverTimer,
    drop,
    setCollapsed,
    busy,
    conflict,
    setPicker,
    reorderModule,
    layout,
    setEditing,
    confirm,
    save,
    selection,
    setSelection,
    drag,
  } = organizer;
  const disabled = busy || conflict;
  const sourceId = module.id || null;
  const visible = module.quizIds.filter((id) => {
    const quiz = byId.get(id);
    return (
      quiz &&
      quiz.name.toLowerCase().includes(search.toLowerCase()) &&
      (!topic || quiz.topic?.id === topic)
    );
  });
  const isCollapsed = collapsed.includes(module.id);
  return (
    <section
      key={module.id}
      aria-label={module.name}
      className={`relative rounded-xl border p-4 pb-6 space-y-3 ${over === `${module.id}:end` ? "ring-2 ring-primary bg-primary/5" : ""}`}
      onDragOver={(e) => hover(e, module.id)}
      onDragLeave={(e) => {
        if (
          !e.currentTarget.contains(e.relatedTarget as Node | null) &&
          hoverTimer.current
        ) {
          clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
        }
      }}
      onDrop={(e) => drop(e, sourceId)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          className="text-left font-semibold"
          onClick={() =>
            setCollapsed((prev) =>
              isCollapsed
                ? prev.filter((id) => id !== module.id)
                : [...prev, module.id],
            )
          }
        >
          {isCollapsed ? "▸" : "▾"} {module.name}{" "}
          <span className="text-muted-foreground font-normal">
            ({module.quizIds.length})
          </span>
        </button>
        {module.id && (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                setPicker({ moduleId: module.id, ids: [], search: "" })
              }
            >
              <Plus className="size-3" /> Add quizzes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move ${module.name} up`}
              disabled={disabled || moduleIndex === 0}
              onClick={() => reorderModule(module.id, -1)}
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move ${module.name} down`}
              disabled={disabled || moduleIndex === layout.modules.length - 1}
              onClick={() => reorderModule(module.id, 1)}
            >
              <ArrowDown className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Edit ${module.name}`}
              disabled={disabled}
              onClick={() => setEditing({ ...module, isNew: false })}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete ${module.name}`}
              disabled={disabled}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Delete ${module.name}?`,
                    description:
                      "Quizzes stay assigned to this class with their settings and student results intact.",
                    confirmText: "Delete module",
                  })
                )
                  void save(
                    layout.modules.filter((m) => m.id !== module.id),
                    "Module deleted. Quizzes kept.",
                  );
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}
      </div>
      {module.description && (
        <p className="text-sm text-muted-foreground whitespace-pre-wrap">
          {module.description}
        </p>
      )}
      {!isCollapsed && (
        <>
          {visible.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={
                  selection.sourceId === sourceId &&
                  visible.every((id) => selection.ids.includes(id))
                }
                onChange={(e) =>
                  setSelection({
                    sourceId,
                    ids: e.target.checked ? visible : [],
                  })
                }
              />
              Select visible quizzes
            </label>
          )}
          {visible.map((id) => (
            <ModuleQuizRow
              key={id}
              organizer={organizer}
              module={module}
              id={id}
            />
          ))}
          {!visible.length && (
            <p className="text-sm text-muted-foreground py-4">
              {search || topic
                ? "No matching quizzes."
                : module.id
                  ? "Add quizzes or drop them here."
                  : "No quizzes outside modules."}
            </p>
          )}
          {drag && module.id && (
            <div className="pointer-events-none absolute inset-x-4 bottom-1 rounded-md bg-background/95 text-center text-xs text-muted-foreground">
              Drop here to append to {module.name}
            </div>
          )}
        </>
      )}
    </section>
  );
}
