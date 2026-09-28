import { Button } from "@/components/ui/button";
import { moveModuleQuizzes } from "@/lib/class-modules";
import type { ModuleOrganizerState } from "./useModuleOrganizer";
export function ModuleSelectionToolbar({
  organizer,
}: {
  organizer: ModuleOrganizerState;
}) {
  const {
    selection,
    setSelection,
    target,
    setTarget,
    layout,
    busy,
    conflict,
    move,
    save,
    setEditing,
  } = organizer;
  return (
    <>
      {" "}
      {selection.ids.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3 shadow-sm">
          <span className="text-sm">{selection.ids.length} selected</span>
          <select
            aria-label="Destination module"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded-md border bg-background p-2 text-sm"
          >
            <option value="">Choose module…</option>
            {layout.modules
              .filter((m) => m.id !== selection.sourceId)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
          <Button
            size="sm"
            disabled={
              !target || busy || conflict || target === selection.sourceId
            }
            onClick={() => move(selection, target)}
          >
            Move to module
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={
              !target || busy || conflict || target === selection.sourceId
            }
            onClick={() =>
              void save(
                moveModuleQuizzes(layout.modules, selection.ids, null, target),
                "Quizzes added to another module.",
              )
            }
          >
            Add to another module
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || conflict}
            onClick={() =>
              setEditing({
                id: crypto.randomUUID(),
                name: "",
                description: "",
                isNew: true,
              })
            }
          >
            New module from selection
          </Button>
          {selection.sourceId && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || conflict}
              onClick={() => move(selection, null)}
            >
              Remove from module
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setSelection({ sourceId: null, ids: [] })}
          >
            Clear selection
          </Button>
        </div>
      )}
    </>
  );
}
