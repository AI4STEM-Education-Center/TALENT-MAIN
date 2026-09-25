"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeNumericValue } from "@/lib/quiz-scoring";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { loadQuizEditorData } from "./quiz-editor-load";
import type {
  AnswerMode,
  FormOption,
  Option,
  Question,
  QuizDetail,
  Topic,
} from "./quiz-editor-types";

const emptyOption = (): FormOption => ({
  id: crypto.randomUUID(),
  text: "",
  isCorrect: false,
});
const emptyOptions = (): FormOption[] => [
  emptyOption(),
  emptyOption(),
  emptyOption(),
  emptyOption(),
];

/** How often to re-fetch while the worker generates or revises a simulation. */
const SIMULATION_POLL_INTERVAL_MS = 5_000;

export function useQuizEditor(quizId: string) {
  const confirm = useConfirm();
  const router = useRouter();

  const refreshAbortRef = useRef<AbortController | null>(null);
  const saveInFlight = useRef(false);
  const [savingQuestion, setSavingQuestion] = useState(false);
  useEffect(() => () => refreshAbortRef.current?.abort(), []);

  const [quiz, setQuiz] = useState<QuizDetail | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // A failed load is distinct from a missing quiz, and cannot use `msg`:
  // `msg` renders below the `!quiz` early return, so it would be unreachable.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [form, setForm] = useState({
    text: "",
    difficultyLevel: "BEGINNER",
    answerMode: "SINGLE_SELECT" as AnswerMode,
    options: emptyOptions(),
    // NUMERIC fields are held as raw input strings; parsed/validated on save.
    answerNumeric: "",
    answerTolerance: "",
    answerUnit: "",
  });
  const [poolImportBusy, setPoolImportBusy] = useState(false);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  // True while a question reorder is being saved; disables the move controls.
  const [reorderBusy, setReorderBusy] = useState(false);
  // The question whose drag handle is being dragged, if any.
  const [draggedQuestionId, setDraggedQuestionId] = useState<string | null>(
    null,
  );
  // True while a PDF import is in progress; hides the QTI card to free up space.
  const [pdfImportActive, setPdfImportActive] = useState(false);
  // Simulation being viewed/reviewed in the dialog, if any.
  const [openSimulationId, setOpenSimulationId] = useState<string | null>(null);
  // Keys ("quiz" / `q:<questionId>`) with a simulation action in flight.
  const [simBusy, setSimBusy] = useState<Set<string>>(new Set());
  const [msg, setMsgText] = useState("");
  // Set alongside `msg` when a safety check refused the submission, so the
  // banner can offer a way to report it. Every other message clears it, which
  // is why setMsg wraps both — a report button outliving its message would
  // attach a user's complaint to the wrong thing.
  const [guardrailEventId, setGuardrailEventId] = useState<string | null>(null);
  const setMsg = useCallback((text: string, eventId: string | null = null) => {
    setMsgText(text);
    setGuardrailEventId(eventId);
  }, []);
  // The "New Question" form renders inline at the end of the list; scroll it
  // into view when opened so it isn't missed below a long list of questions.
  const addFormRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Only the request that still owns this controller may write state, so a
    // superseded load can neither clear `loading` for its successor nor
    // overwrite the newer quiz.
    setLoading(true);
    setLoadError(null);
    setNotFound(false);

    void (async () => {
      const result = await loadQuizEditorData<QuizDetail, Topic>(
        quizId,
        controller.signal,
      );
      if (controller.signal.aborted || result.kind === "aborted") return;
      if (result.kind === "notFound") setNotFound(true);
      else if (result.kind === "error") setLoadError(result.message);
      else {
        setQuiz(result.quiz);
        setTopics(result.topics);
      }
      setLoading(false);
    })();

    return () => controller.abort();
  }, [quizId]);

  useEffect(() => {
    if (showForm && !editingQuestion) {
      addFormRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [showForm, editingQuestion]);

  const refreshQuestions = useCallback(async () => {
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    try {
      const res = await fetch(`/api/quizzes/${quizId}`, {
        signal: controller.signal,
      });
      if (!res.ok)
        throw new Error(
          `Could not refresh the question list (HTTP ${res.status}).`,
        );
      const next = await res.json();
      if (!controller.signal.aborted) setQuiz(next);
    } catch (error) {
      if (!controller.signal.aborted)
        setMsg(
          error instanceof Error
            ? error.message
            : "Could not refresh the question list.",
        );
    }
  }, [quizId, setMsg]);

  // While the worker is generating or revising a simulation for this quiz,
  // poll so the badges settle (and the artifact becomes viewable) without a
  // manual reload. In-progress edits live in `form`, so a refresh is safe.
  const simsInFlight = (quiz?.questions ?? []).some(
    (q) =>
      q.simulation?.status === "PENDING" || q.simulation?.status === "REVISING",
  );
  useEffect(() => {
    if (!simsInFlight) return;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await refreshQuestions();
      } finally {
        inFlight = false;
      }
    }, SIMULATION_POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      refreshAbortRef.current?.abort();
    };
  }, [simsInFlight, refreshQuestions]);

  async function saveName() {
    if (!nameDraft.trim() || !quiz) return;
    try {
      const res = await fetch(`/api/quizzes/${quizId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameDraft.trim() }),
      });
      if (!res.ok) throw new Error("Could not rename the quiz.");
      const name = nameDraft.trim();
      setQuiz((current) => (current ? { ...current, name } : current));
      setEditingName(false);
    } catch {
      setMsg("Could not rename the quiz.");
    }
  }

  async function changeTopic(topicId: string) {
    if (!quiz) return;
    try {
      const res = await fetch(`/api/quizzes/${quizId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId: topicId || null }),
      });
      if (!res.ok) throw new Error("Could not change the topic.");
      const updated = await res.json();
      setQuiz((current) =>
        current
          ? { ...current, topicId: updated.topicId, topic: updated.topic }
          : current,
      );
    } catch {
      setMsg("Could not change the topic.");
    }
  }

  // Teacher previewing a pool quiz: pull an independent copy into their own list.
  async function importPoolCopy() {
    setPoolImportBusy(true);
    try {
      const res = await fetch(`/api/quizzes/pool/${quizId}/import`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error ?? "Import failed.");
        return;
      }
      router.push(`/teacher/quizzes/${data.id}`);
    } catch {
      setMsg("Could not import this quiz. Please try again.");
    } finally {
      setPoolImportBusy(false);
    }
  }

  // Deep-copy this quiz into the same scope and open the copy. `basePath` is the
  // editor's list route (teacher or admin), so the copy opens in the same area.
  async function duplicateQuiz(basePath: string) {
    setDuplicateBusy(true);
    try {
      const res = await fetch(`/api/quizzes/${quizId}/duplicate`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data.error ?? "Could not duplicate this quiz.");
        return;
      }
      router.push(`${basePath}/${data.id}`);
    } catch {
      setMsg("Could not duplicate this quiz. Please try again.");
    } finally {
      setDuplicateBusy(false);
    }
  }

  // ── Question order ──────────────────────────────────────────────────────────
  // Optimistic: the list reorders immediately and rolls back if the save fails.

  async function saveQuestionOrder(ids: string[]) {
    if (!quiz || reorderBusy) return;
    const previous = quiz.questions;
    const byId = new Map(previous.map((q) => [q.id, q]));
    setQuiz({ ...quiz, questions: ids.map((id) => byId.get(id)!) });
    setReorderBusy(true);
    try {
      const res = await fetch(`/api/quizzes/${quizId}/question-order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionIds: ids }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not save the new order.");
      }
    } catch (error) {
      setQuiz((current) =>
        current ? { ...current, questions: previous } : current,
      );
      setMsg(
        error instanceof Error
          ? error.message
          : "Could not save the new order.",
      );
      await refreshQuestions();
    } finally {
      setReorderBusy(false);
    }
  }

  /** Move a question `delta` places (-1 = up, 1 = down). */
  function moveQuestion(id: string, delta: number) {
    if (!quiz) return;
    const ids = quiz.questions.map((q) => q.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void saveQuestionOrder(ids);
  }

  /** Drop the dragged question into `targetId`'s slot. */
  function dropQuestion(targetId: string) {
    const dragged = draggedQuestionId;
    setDraggedQuestionId(null);
    if (!quiz || !dragged || dragged === targetId) return;
    const ids = quiz.questions.map((q) => q.id);
    const from = ids.indexOf(dragged);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void saveQuestionOrder(ids);
  }

  function startEdit(q: Question) {
    setEditingQuestion(q);
    setForm({
      text: q.text,
      difficultyLevel: q.difficultyLevel,
      answerMode: q.answerMode ?? "SINGLE_SELECT",
      // Keep choice options even for a NUMERIC question (usually empty), so a
      // teacher who switches the type back doesn't lose any prior options.
      options:
        q.options.length > 0
          ? q.options.map((o) => ({
              id: o.id ?? crypto.randomUUID(),
              text: o.text,
              isCorrect: o.isCorrect,
              // Image choices ride along so a text edit doesn't drop them: the
              // id is echoed to PATCH, which preserves the stored crop by id.
              imageUrl: o.imageUrl ?? null,
              imageAlt: o.imageAlt ?? null,
              hasImage: o.hasImage ?? Boolean(o.imageUrl),
            }))
          : emptyOptions(),
      answerNumeric: q.answerNumeric != null ? String(q.answerNumeric) : "",
      answerTolerance:
        q.answerTolerance != null ? String(q.answerTolerance) : "",
      answerUnit: q.answerUnit ?? "",
    });
    setShowForm(true);
  }

  function resetForm() {
    setForm({
      text: "",
      difficultyLevel: "BEGINNER",
      answerMode: "SINGLE_SELECT",
      options: emptyOptions(),
      answerNumeric: "",
      answerTolerance: "",
      answerUnit: "",
    });
    setEditingQuestion(null);
    setShowForm(false);
  }

  function setOption(
    index: number,
    field: "text" | "isCorrect",
    value: string | boolean,
  ) {
    setForm((prev) => ({
      ...prev,
      options: prev.options.map((o, i) =>
        i === index ? { ...o, [field]: value } : o,
      ),
    }));
  }

  // Generate the new option's id at event time, not during render, so no random
  // value is reached from JSX (which would risk a server/client hydration drift).
  function addOption() {
    setForm((prev) => ({
      ...prev,
      options: [
        ...prev.options,
        { id: crypto.randomUUID(), text: "", isCorrect: false },
      ],
    }));
  }

  function markCorrect(index: number) {
    setForm((prev) => ({
      ...prev,
      options: prev.options.map((o, i) => ({
        ...o,
        isCorrect:
          prev.answerMode === "MULTI_SELECT"
            ? i === index
              ? !o.isCorrect
              : o.isCorrect
            : i === index,
      })),
    }));
  }

  function setAnswerMode(answerMode: AnswerMode) {
    setForm((prev) => ({
      ...prev,
      answerMode,
      options:
        answerMode === "SINGLE_SELECT"
          ? prev.options.map((option, index) => ({
              ...option,
              isCorrect: index === prev.options.findIndex((o) => o.isCorrect),
            }))
          : prev.options,
    }));
  }

  async function saveQuestion() {
    if (saveInFlight.current) return;
    if (!form.text.trim()) {
      setMsg("Fill in the question text.");
      return;
    }

    const isNumeric = form.answerMode === "NUMERIC";
    let body: Record<string, unknown>;

    if (isNumeric) {
      // Client validation mirrors the API: a finite answer is required, and a
      // tolerance — if given — must be > 0.
      const answerNumeric = normalizeNumericValue(form.answerNumeric);
      if (answerNumeric === null) {
        setMsg("Enter a valid numeric answer.");
        return;
      }
      let answerTolerance: number | null = null;
      if (form.answerTolerance.trim()) {
        const tol = normalizeNumericValue(form.answerTolerance);
        if (tol === null || tol <= 0) {
          setMsg("Tolerance must be a positive number.");
          return;
        }
        answerTolerance = tol;
      }
      const answerUnit = form.answerUnit.trim() || null;
      const numericFields = {
        answerMode: "NUMERIC",
        answerNumeric,
        answerTolerance,
        answerUnit,
        options: [] as Option[],
      };
      body = editingQuestion
        ? {
            id: editingQuestion.id,
            text: form.text,
            difficultyLevel: form.difficultyLevel,
            ...numericFields,
          }
        : {
            text: form.text,
            difficultyLevel: form.difficultyLevel,
            quizId,
            ...numericFields,
          };
    } else {
      // An option counts if it has text OR is an image choice (image options
      // store text = "" by design — see the Option schema comment). hasImage,
      // not imageUrl, is the image signal: a transient presign failure must
      // not get a stored crop silently filtered out and deleted on save.
      const validOptions = form.options.filter(
        (o) => o.text.trim() || o.hasImage,
      );
      if (validOptions.length < 2) {
        setMsg("Add at least 2 options.");
        return;
      }
      if (!validOptions.some((o) => o.isCorrect)) {
        setMsg("Mark one option as correct.");
        return;
      }
      body = editingQuestion
        ? {
            id: editingQuestion.id,
            text: form.text,
            difficultyLevel: form.difficultyLevel,
            answerMode: form.answerMode,
            options: validOptions,
          }
        : {
            text: form.text,
            difficultyLevel: form.difficultyLevel,
            answerMode: form.answerMode,
            quizId,
            options: validOptions,
          };
    }

    saveInFlight.current = true;
    setSavingQuestion(true);
    try {
      const method = editingQuestion ? "PATCH" : "POST";
      const res = await fetch("/api/questions", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // A refusal used to leave the form sitting there with no explanation,
        // which reads as a dead Save button. A guardrail block is now a likely
        // reason to land here, and it comes with an id the teacher can dispute.
        const data = await res.json().catch(() => ({}));
        setMsg(
          data.error ?? "Could not save this question.",
          data.guardrailEventId ?? null,
        );
        return;
      }

      setMsg(editingQuestion ? "Question updated." : "Question created.");
      resetForm();
      await refreshQuestions();
    } catch {
      setMsg("Could not save this question. Please try again.");
    } finally {
      saveInFlight.current = false;
      setSavingQuestion(false);
    }
  }

  async function deleteQuestion(id: string) {
    const ok = await confirm({
      title: "Delete this question?",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const res = await fetch("/api/questions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error("Delete failed");
      setQuiz((prev) =>
        prev
          ? { ...prev, questions: prev.questions.filter((q) => q.id !== id) }
          : prev,
      );
    } catch {
      setMsg("Could not delete this question. Please try again.");
    }
  }

  // ── Simulations ─────────────────────────────────────────────────────────────
  // These act on THIS quiz's own simulation rows. A quiz imported from the
  // global pool carries its own rows over shared, immutable artifacts (every
  // (re)generation writes a new versioned object — see deepCopyQuiz), so
  // generating, regenerating or deleting here never touches the pool version.

  const simBusyFor = (questionId: string) => simBusy.has(`q:${questionId}`);

  async function withSimBusy(busyKey: string, run: () => Promise<void>) {
    setSimBusy((prev) => new Set(prev).add(busyKey));
    try {
      await run();
    } catch {
      setMsg("The simulation request failed. Please try again.");
    } finally {
      setSimBusy((prev) => {
        const next = new Set(prev);
        next.delete(busyKey);
        return next;
      });
    }
  }

  async function generateSimulations(
    payload:
      | { scope: "quiz"; quizId: string }
      | { scope: "question"; questionId: string; force?: boolean },
    busyKey: string,
  ) {
    setMsg("");
    await withSimBusy(busyKey, async () => {
      const res = await fetch("/api/simulations/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // Status before body; the error payload is read only in this branch.
        const errorBody = await res
          .json()
          .catch(() => ({}) as { error?: string });
        setMsg(errorBody.error ?? "Failed to start simulation generation.");
        return;
      }
      const data = await res.json().catch(() => ({}));
      const parts = [
        data.created > 0 ? `${data.created} queued` : null,
        data.retried > 0 ? `${data.retried} re-queued` : null,
        data.skipped > 0 ? `${data.skipped} skipped` : null,
        data.enqueueFailed > 0
          ? `${data.enqueueFailed} failed to enqueue`
          : null,
      ].filter(Boolean);
      setMsg(
        parts.length > 0
          ? `Simulation generation started: ${parts.join(", ")}.`
          : "Nothing to generate.",
      );
      await refreshQuestions();
    });
  }

  async function regenerateSimulation(q: Question) {
    const sim = q.simulation;
    if (!sim) return;
    const stuck = sim.status === "PENDING" || sim.status === "REVISING";
    const ok = await confirm({
      title: stuck ? "Restart this generation?" : "Regenerate this simulation?",
      description: stuck
        ? "Use this only when a job looks stuck (e.g. the worker restarted). The current job's result will be discarded."
        : "The current simulation (and its decline decision, if any) is replaced by a fresh generation. Only this quiz's copy changes — the global pool version is untouched.",
      confirmText: stuck ? "Restart" : "Regenerate",
    });
    if (!ok) return;
    await generateSimulations(
      { scope: "question", questionId: q.id, force: true },
      `q:${q.id}`,
    );
  }

  async function deleteSimulation(q: Question) {
    const sim = q.simulation;
    if (!sim) return;
    const ok = await confirm({
      title: "Delete this simulation?",
      description:
        "The simulation and its feedback history are permanently removed from this question, and students stop seeing it. Only this quiz's copy is affected — the global pool version is untouched. You can generate a fresh one later.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    setMsg("");
    await withSimBusy(`q:${q.id}`, async () => {
      const res = await fetch(`/api/simulations/${sim.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMsg(data.error ?? "Failed to delete the simulation.");
        return;
      }
      setMsg("Simulation deleted.");
      await refreshQuestions();
    });
  }

  return {
    savingQuestion,
    quiz,
    topics,
    loading,
    notFound,
    loadError,
    editingName,
    setEditingName,
    nameDraft,
    setNameDraft,
    showForm,
    setShowForm,
    editingQuestion,
    form,
    setForm,
    poolImportBusy,
    duplicateBusy,
    duplicateQuiz,
    reorderBusy,
    moveQuestion,
    draggedQuestionId,
    setDraggedQuestionId,
    dropQuestion,
    pdfImportActive,
    setPdfImportActive,
    openSimulationId,
    setOpenSimulationId,
    simBusy,
    msg,
    guardrailEventId,
    setMsg,
    addFormRef,
    refreshQuestions,
    saveName,
    changeTopic,
    importPoolCopy,
    startEdit,
    resetForm,
    setOption,
    addOption,
    markCorrect,
    setAnswerMode,
    saveQuestion,
    deleteQuestion,
    simBusyFor,
    generateSimulations,
    regenerateSimulation,
    deleteSimulation,
  };
}

export type QuizEditorModel = ReturnType<typeof useQuizEditor>;
