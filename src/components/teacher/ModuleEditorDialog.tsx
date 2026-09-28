import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { moveModuleQuizzes } from "@/lib/class-modules";
import type { ModuleOrganizerState } from "./useModuleOrganizer";
export function ModuleEditorDialog({
  organizer,
}: {
  organizer: ModuleOrganizerState;
}) {
  const {
    editing,
    setEditing,
    busy,
    conflict,
    selection,
    layout,
    save,
    setPicker,
    error,
  } = organizer;
  return (
    <Dialog
      open={!!editing}
      onOpenChange={(open) => !open && !busy && setEditing(null)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing?.isNew ? "Create module" : "Edit module"}
          </DialogTitle>
          <DialogDescription>
            {editing?.isNew && selection.ids.length
              ? `${selection.ids.length} selected quizzes will move into this module.`
              : "Group existing quizzes for a midterm, final, or another learning goal."}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <form
          className="space-y-4"
          action={async () => {
            if (!editing) return;
            const { id, name, description, isNew } = editing;
            let modules = isNew
              ? [...layout.modules, { id, name, description, quizIds: [] }]
              : layout.modules.map((m) =>
                  m.id === id ? { ...m, name, description } : m,
                );
            if (isNew && selection.ids.length)
              modules = moveModuleQuizzes(
                modules,
                selection.ids,
                selection.sourceId,
                id,
              );
            if (
              await save(modules, isNew ? "Module created." : "Module saved.")
            ) {
              setEditing(null);
              if (isNew && !selection.ids.length)
                setPicker({ moduleId: id, ids: [], search: "" });
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="module-name">Name</Label>
            <Input
              id="module-name"
              autoFocus
              required
              maxLength={100}
              placeholder="Midterm Prep"
              value={editing?.name ?? ""}
              onChange={(e) =>
                setEditing((prev) => prev && { ...prev, name: e.target.value })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="module-description">Description (optional)</Label>
            <Textarea
              id="module-description"
              maxLength={1000}
              value={editing?.description ?? ""}
              onChange={(e) =>
                setEditing(
                  (prev) => prev && { ...prev, description: e.target.value },
                )
              }
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || conflict || !editing?.name.trim()}
            >
              Save module
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
