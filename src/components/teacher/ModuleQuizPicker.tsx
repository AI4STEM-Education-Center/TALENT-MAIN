import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
export function ModuleQuizPicker({
  organizer,
}: {
  organizer: ModuleOrganizerState;
}) {
  const {
    picker,
    setPicker,
    busy,
    conflict,
    quizzes,
    layout,
    assignedQuizIds,
    save,
    error,
  } = organizer;
  return (
    <Dialog
      open={!!picker}
      onOpenChange={(open) => !open && !busy && setPicker(null)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add existing quizzes</DialogTitle>
          <DialogDescription>
            Choose from your quiz library. New class assignments are drafts.
            Existing publication, dates, and attempts stay the same.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Input
          aria-label="Search quiz library"
          placeholder="Search quiz name or topic…"
          value={picker?.search ?? ""}
          onChange={(e) =>
            setPicker((prev) => prev && { ...prev, search: e.target.value })
          }
        />
        <div className="max-h-80 overflow-y-auto space-y-2">
          {quizzes
            .filter((q) =>
              `${q.name} ${q.topic?.name ?? ""}`
                .toLowerCase()
                .includes((picker?.search ?? "").toLowerCase()),
            )
            .map((quiz) => {
              const included = layout.modules
                .find((m) => m.id === picker?.moduleId)
                ?.quizIds.includes(quiz.id);
              return (
                <label
                  key={quiz.id}
                  className="flex items-start gap-3 rounded-lg border p-3"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={busy || included}
                    checked={included || picker?.ids.includes(quiz.id) || false}
                    onChange={(e) =>
                      setPicker(
                        (prev) =>
                          prev && {
                            ...prev,
                            ids: e.target.checked
                              ? [...prev.ids, quiz.id]
                              : prev.ids.filter((id) => id !== quiz.id),
                          },
                      )
                    }
                  />
                  <span>
                    <span className="font-medium">{quiz.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {quiz.topic?.name ? `${quiz.topic.name} · ` : ""}
                      {quiz._count.questions} questions ·{" "}
                      {included
                        ? "Already in module"
                        : assignedQuizIds.includes(quiz.id)
                          ? "Assigned to class"
                          : "Will be added as draft"}
                    </span>
                  </span>
                </label>
              );
            })}
          {quizzes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Create quizzes in your library first.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setPicker(null)}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || conflict || !picker?.ids.length}
            onClick={async () => {
              if (
                picker &&
                (await save(
                  moveModuleQuizzes(
                    layout.modules,
                    picker.ids,
                    null,
                    picker.moduleId,
                  ),
                  "Quizzes added to module.",
                ))
              )
                setPicker(null);
            }}
          >
            Add selected quizzes
            {picker?.ids.length ? ` (${picker.ids.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
