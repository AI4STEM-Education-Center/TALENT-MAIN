"use client";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useModuleOrganizer,
  type ModuleOrganizerProps,
} from "./useModuleOrganizer";
import { ModuleSection } from "./ModuleSection";
import { ModuleEditorDialog } from "./ModuleEditorDialog";
import { ModuleQuizPicker } from "./ModuleQuizPicker";
import { ModuleSelectionToolbar } from "./ModuleSelectionToolbar";
export function ModuleOrganizer(props: ModuleOrganizerProps) {
  const organizer = useModuleOrganizer(props);
  const {
    busy,
    conflict,
    setEditing,
    search,
    setSearch,
    topic,
    setTopic,
    topics,
    message,
    undo,
    save,
    reload,
    layout,
    sections,
  } = organizer;

  return (
    <section className="space-y-4" aria-label="Quiz modules" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Modules</h2>
          <p className="text-sm text-muted-foreground">
            Select quizzes to move them, or drag a handle into a module. Quiz
            settings and results stay the same.
          </p>
        </div>
        <Button
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
          <Plus className="size-4" /> Create module
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Search assigned quizzes"
          placeholder="Search assigned quizzes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-sm"
        />
        <select
          aria-label="Filter quizzes by topic"
          className="rounded-md border bg-background p-2 text-sm"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
        >
          <option value="">All topics</option>
          {topics.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <div role="status" aria-live="polite" className="text-sm">
        {busy ? "Saving…" : message}{" "}
        {undo && !conflict && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void save(
                undo,
                "Organization restored. Added class quizzes remain assigned.",
                true,
              )
            }
          >
            Undo
          </Button>
        )}
        {conflict && (
          <Button size="sm" disabled={busy} onClick={() => void reload()}>
            Reload modules
          </Button>
        )}
      </div>
      <ModuleSelectionToolbar organizer={organizer} />
      {layout.modules.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Create a module such as Midterm Prep, then add existing quizzes. You
          can also select quizzes below to create a module.
        </p>
      )}
      {sections.map((module, moduleIndex) => (
        <ModuleSection
          key={module.id}
          organizer={organizer}
          module={module}
          moduleIndex={moduleIndex}
        />
      ))}
      <ModuleEditorDialog organizer={organizer} />
      <ModuleQuizPicker organizer={organizer} />
    </section>
  );
}
