"use client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type DragEvent,
} from "react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  moveModuleQuizzes,
  type ModuleLayout,
  type QuizModule,
} from "@/lib/class-modules";
interface Quiz {
  id: string;
  name: string;
  topic: { id: string; name: string } | null;
  _count: { questions: number };
}
export interface ModuleOrganizerProps {
  classId: string;
  initialLayout: ModuleLayout;
  quizzes: Quiz[];
  assignedQuizIds: string[];
  renderQuiz: (id: string) => ReactNode;
  onSaved: () => Promise<void>;
}
interface Selection {
  sourceId: string | null;
  ids: string[];
}

export function useModuleOrganizer({
  classId,
  initialLayout,
  quizzes,
  assignedQuizIds,
  renderQuiz,
  onSaved,
}: ModuleOrganizerProps) {
  const confirm = useConfirm();
  const [layout, setLayout] = useState(initialLayout);
  const [undo, setUndo] = useState<QuizModule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [selection, setSelection] = useState<Selection>({
    sourceId: null,
    ids: [],
  });
  const [target, setTarget] = useState("");
  const [search, setSearch] = useState("");
  const [topic, setTopic] = useState("");
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    description: string;
    isNew: boolean;
  } | null>(null);
  const [picker, setPicker] = useState<{
    moduleId: string;
    ids: string[];
    search: string;
  } | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [drag, setDrag] = useState<Selection | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );
  const byId = new Map(quizzes.map((quiz) => [quiz.id, quiz]));
  const topics = [
    ...new Map(
      quizzes.flatMap((q) => (q.topic ? [[q.topic.id, q.topic] as const] : [])),
    ).values(),
  ];
  const inModules = new Set(layout.modules.flatMap((module) => module.quizIds));
  const otherIds = assignedQuizIds.filter((id) => !inModules.has(id));
  const sections = [
    ...layout.modules,
    {
      id: "",
      name: "Other quizzes",
      description: "Quizzes outside modules",
      quizIds: otherIds,
    },
  ];

  async function save(modules: QuizModule[], label: string, isUndo = false) {
    if (saving.current || conflict) return false;
    saving.current = true;
    setBusy(true);
    setError("");
    const previous = layout;
    setLayout({ ...layout, modules });
    try {
      const res = await fetch(`/api/classes/${classId}/modules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: layout.revision, modules }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) setConflict(true);
        throw new Error(data.error ?? "Could not save modules.");
      }
      setLayout(data);
      setUndo(isUndo ? null : previous.modules);
      setSelection({ sourceId: null, ids: [] });
      setMessage(label);
      try {
        await onSaved();
      } catch {
        setMessage(`${label} Refresh the page to update quiz settings.`);
      }
      return true;
    } catch (error) {
      setLayout(previous);
      const detail =
        error instanceof Error
          ? error.message
          : "Could not save modules. Please try again.";
      setMessage(detail);
      setError(detail);
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function reload() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/classes/${classId}/modules`);
      if (!res.ok) throw new Error();
      setLayout(await res.json());
      await onSaved();
      setConflict(false);
      setUndo(null);
      setSelection({ sourceId: null, ids: [] });
      setMessage("Modules reloaded. Please make your change again.");
    } catch {
      setMessage("Could not reload modules. Please try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function select(sourceId: string | null, id: string) {
    setSelection((prev) => {
      const ids = prev.sourceId === sourceId ? prev.ids : [];
      return {
        sourceId,
        ids: ids.includes(id)
          ? ids.filter((value) => value !== id)
          : [...ids, id],
      };
    });
  }
  function move(items: Selection, targetId: string | null, before?: string) {
    if (before && items.ids.includes(before)) return;
    void save(
      moveModuleQuizzes(
        layout.modules,
        items.ids,
        items.sourceId,
        targetId,
        before,
      ),
      `${items.ids.length} quiz${items.ids.length === 1 ? "" : "zes"} moved.`,
    );
  }
  function endDrag() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setDrag(null);
    setOver(null);
  }
  function drop(event: DragEvent, moduleId: string | null, before?: string) {
    event.preventDefault();
    event.stopPropagation();
    if (drag && !busy && !conflict) move(drag, moduleId, before);
    endDrag();
  }
  function hover(event: DragEvent, moduleId: string, before?: string) {
    if (!drag || busy || conflict) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setOver(`${moduleId}:${before ?? "end"}`);
    if (collapsed.includes(moduleId) && !hoverTimer.current) {
      hoverTimer.current = setTimeout(() => {
        setCollapsed((prev) => prev.filter((id) => id !== moduleId));
        hoverTimer.current = null;
      }, 600);
    }
  }
  function reorderModule(id: string, offset: number) {
    const modules = [...layout.modules];
    const index = modules.findIndex((module) => module.id === id);
    const [item] = modules.splice(index, 1);
    modules.splice(index + offset, 0, item);
    void save(modules, "Module order saved.");
  }
  function reorderQuiz(module: QuizModule, id: string, offset: number) {
    const ids = [...module.quizIds];
    const index = ids.indexOf(id);
    const [item] = ids.splice(index, 1);
    ids.splice(index + offset, 0, item);
    void save(
      layout.modules.map((m) =>
        m.id === module.id ? { ...m, quizIds: ids } : m,
      ),
      "Quiz order saved.",
    );
  }

  return {
    confirm,
    layout,
    undo,
    busy,
    message,
    error,
    conflict,
    selection,
    setSelection,
    target,
    setTarget,
    search,
    setSearch,
    topic,
    setTopic,
    editing,
    setEditing,
    picker,
    setPicker,
    collapsed,
    setCollapsed,
    drag,
    setDrag,
    over,
    hoverTimer,
    byId,
    topics,
    sections,
    save,
    reload,
    select,
    move,
    endDrag,
    drop,
    hover,
    reorderModule,
    reorderQuiz,
    quizzes,
    assignedQuizIds,
    renderQuiz,
  };
}
export type ModuleOrganizerState = ReturnType<typeof useModuleOrganizer>;
