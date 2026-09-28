import { GripVertical, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QuizModule } from "@/lib/class-modules";
import type { ModuleOrganizerState } from "./useModuleOrganizer";

export function ModuleQuizRow({
  organizer,
  module,
  id,
}: {
  organizer: ModuleOrganizerState;
  module: QuizModule;
  id: string;
}) {
  const {
    byId,
    over,
    hover,
    drop,
    busy,
    conflict,
    selection,
    select,
    setDrag,
    endDrag,
    reorderQuiz,
    renderQuiz,
  } = organizer;
  const quiz = byId.get(id)!;
  const sourceId = module.id || null;
  const index = module.quizIds.indexOf(id);
  return (
    <div
      key={id}
      className={`rounded-lg ${over === `${module.id}:${id}` ? "border-t-4 border-primary" : "border-t-4 border-transparent"}`}
      onDragOver={(e) => hover(e, module.id, id)}
      onDrop={(e) => drop(e, sourceId, id)}
    >
      <div className="flex items-center gap-2 mb-1">
        <input
          type="checkbox"
          aria-label={`Select ${quiz.name} in ${module.name}`}
          disabled={busy || conflict}
          checked={
            selection.sourceId === sourceId && selection.ids.includes(id)
          }
          onChange={() => select(sourceId, id)}
        />
        <button
          type="button"
          draggable={!busy && !conflict}
          disabled={busy || conflict}
          aria-label={`Drag ${quiz.name}; use selection and move buttons as an alternative`}
          className="cursor-grab touch-none p-2 rounded hover:bg-muted"
          onDragStart={(e) => {
            const items =
              selection.sourceId === sourceId && selection.ids.includes(id)
                ? selection
                : { sourceId, ids: [id] };
            setDrag(items);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", quiz.name);
          }}
          onDragEnd={endDrag}
        >
          <GripVertical className="size-4 pointer-events-none" />
        </button>
        {module.id && (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move ${quiz.name} up in ${module.name}`}
              disabled={busy || conflict || index === 0}
              onClick={() => reorderQuiz(module, id, -1)}
            >
              <ArrowUp className="size-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move ${quiz.name} down in ${module.name}`}
              disabled={busy || conflict || index === module.quizIds.length - 1}
              onClick={() => reorderQuiz(module, id, 1)}
            >
              <ArrowDown className="size-3" />
            </Button>
          </>
        )}
      </div>
      {renderQuiz(id) ?? (
        <div className="rounded-lg border p-3">
          {quiz.name}
          <span className="ml-2 text-sm text-muted-foreground">
            Draft · {quiz._count.questions} questions
          </span>
        </div>
      )}
    </div>
  );
}
