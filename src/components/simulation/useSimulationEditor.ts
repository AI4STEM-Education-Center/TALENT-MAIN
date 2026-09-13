"use client";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  SimulationEditPlan,
  SimulationEditStreamEvent,
} from "@/lib/simulation-edit";
import { readNdjson } from "@/lib/assistant/ndjson";
import {
  coalesceSimulationPatches,
  describeSimulationPatch,
  type SimulationFormula,
  type SimulationPatch,
  type StagedPatch,
} from "@/lib/simulation-patch";
import type { SimulationPreviewEdit } from "@/lib/simulation-preview-edit";
import { renderSimulationFormulaHtml } from "@/lib/simulation-math";
type Display = "inline" | "block";
export type Version = {
  number: number;
  name: string;
  parentNumber: number | null;
};
type Chat = {
  id: string;
  baseVersion: number;
  transcript: string;
  plan: string | null;
  state: string;
};
export type Turn = { role: string; content: string };
export type EditorProps = {
  id: string;
  version: number;
  revising: boolean;
  onRefresh: () => Promise<void>;
};
/** Whether the editing chat can answer at all. Both halves are admin-set. */
export type AssistantStatus = { enabled: boolean; model: string | null };
type State = {
  versions: Version[];
  selected: number;
  lastLiveVersion: number;
  chats: Chat[];
  chatId?: string;
  draft: string;
  answers: Record<string, string>;
  busy: boolean;
  error: string;
  eventId: string | null;
  rename: string;
  /** The previewed version's formulas, in the order they appear on screen. */
  formulas: SimulationFormula[];
  /** Edits staged in the preview, applied as one batch when the teacher saves. */
  patches: StagedPatch[];
  /** Whether the preview is armed for editing. */
  editing: boolean;
  /** Bumped to remount the preview and discard on-screen edits. */
  previewNonce: number;
  /** The reply being written right now, painted delta by delta. */
  streaming: string;
  /** The tool the assistant is running, while it runs one. */
  activity: string | null;
  assistant: AssistantStatus;
};
type Update = (
  patch: Partial<State> | ((state: State) => Partial<State>),
) => void;
/** What the version-history endpoint returns. */
type EditorPayload = {
  versions: Version[];
  chats: Chat[];
  formulas?: SimulationFormula[];
  assistant?: AssistantStatus;
  error?: string;
};
/** What an action returns, on success or as a handled failure. */
type ActionPayload = {
  error?: string;
  guardrailEventId?: string;
  chatId?: string;
  showVersion?: number;
};
/**
 * The JSON body, or null when the response is not JSON at all. An editing turn
 * can outlive the CDN's request timeout, and what reaches the browser then is
 * the CDN's own HTML error page rather than anything this app wrote — parsing
 * that as JSON only produces "Unexpected token '<'", which tells a teacher
 * nothing about what happened or what to do next.
 */
async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
/** What a finished editing turn leaves behind for the caller to act on. */
type StreamOutcome = {
  chatId?: string;
  showVersion?: number | null;
  error?: string;
  guardrailEventId?: string | null;
};
/**
 * Drain one editing turn.
 *
 * The assistant answers in two halves: prose, which is painted as each delta
 * lands so the teacher reads it being written, and then the plan the editor
 * turns into buttons. Only the terminal event is handed back — everything the
 * teacher sees on the way has already been applied to the state.
 */
async function readEditStream(
  body: ReadableStream<Uint8Array>,
  update: Update,
): Promise<StreamOutcome> {
  const outcome: StreamOutcome = {};
  for await (const event of readNdjson<SimulationEditStreamEvent>(body)) {
    if (event.type === "delta")
      update((current) => ({ streaming: current.streaming + event.text }));
    else if (event.type === "tool")
      update({ activity: event.status === "running" ? event.label : null });
    else if (event.type === "plan") {
      outcome.chatId = event.chatId;
      outcome.showVersion = event.showVersion;
    } else if (event.type === "error") {
      outcome.error = event.message;
      outcome.guardrailEventId = event.guardrailEventId;
    }
  }
  return outcome;
}
/**
 * Accepts an updater as well as a patch, so a caller that appends to a list can
 * read the state it is appending to. Two preview edits committed before React
 * re-renders would otherwise both build on the same stale array, and the first
 * would be lost.
 */
function reducer(
  state: State,
  patch: Partial<State> | ((state: State) => Partial<State>),
) {
  return { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
}
export function useSimulationEditor({
  id,
  version,
  revising,
  onRefresh,
}: EditorProps) {
  const [state, update] = useReducer(reducer, {
    versions: [],
    selected: version,
    lastLiveVersion: version,
    chats: [],
    draft: "",
    answers: {},
    busy: false,
    error: "",
    eventId: null,
    rename: "",
    formulas: [],
    patches: [],
    editing: false,
    previewNonce: 0,
    streaming: "",
    activity: null,
    assistant: { enabled: true, model: null },
  });
  const inFlight = useRef(false);
  if (version !== state.lastLiveVersion)
    update({
      lastLiveVersion: version,
      selected: version,
      chatId: undefined,
      answers: {},
    });
  const selected = state.selected;
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/simulations/${id}/edit?version=${selected}`);
    const data = await readJson<EditorPayload>(res);
    // An expired session answers here with a 401 and a sentence worth showing —
    // it is the difference between "sign in again" and a dead editor.
    if (!res.ok || !data)
      throw new Error(
        data?.error ?? `Could not load version history (HTTP ${res.status})`,
      );
    update({
      versions: data.versions,
      chats: data.chats,
      formulas: data.formulas ?? [],
      assistant: data.assistant ?? { enabled: true, model: null },
    });
  }, [id, selected]);
  useEffect(() => {
    refresh().catch((e) => update({ error: e.message }));
  }, [refresh, version, revising]);
  const chat =
    state.chats.find(
      (c) => c.id === state.chatId && c.baseVersion === state.selected,
    ) ??
    state.chats.find(
      (c) => c.baseVersion === state.selected && c.state !== "ABORTED",
    );
  const plan: SimulationEditPlan | null = chat?.plan
    ? JSON.parse(chat.plan)
    : null;
  const turns: Turn[] = chat ? JSON.parse(chat.transcript) : [];
  async function act(action: string, message?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    update({
      busy: true,
      error: "",
      eventId: null,
      streaming: "",
      activity: null,
    });
    try {
      const res = await fetch(`/api/simulations/${id}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          version: state.selected,
          chatId:
            action === "abort" || chat?.state === "DISCUSSING"
              ? chat?.id
              : undefined,
          message,
          // An empty rename box means "leave the name alone" — sending "" would
          // fail input validation and take the whole request down with it.
          name: state.rename.trim() || undefined,
          patches:
            action === "patch"
              ? state.patches.map((staged) => staged.patch)
              : undefined,
        }),
      });
      // The chat action answers as a stream — prose first, then the plan.
      // Every other action is a single JSON object.
      if (action === "chat" && res.ok && res.body) {
        const outcome = await readEditStream(res.body, update);
        if (outcome.chatId) update({ chatId: outcome.chatId });
        if (outcome.showVersion)
          update({ selected: outcome.showVersion, chatId: undefined });
        // A failed turn keeps the draft, so a retry does not mean retyping.
        if (outcome.error)
          update({
            error: outcome.error,
            eventId: outcome.guardrailEventId ?? null,
          });
        else update({ draft: "", answers: {} });
        // The conversation moved server-side either way — a saved plan, or a
        // turn released back for another try — so re-read it rather than guess.
        await Promise.all([refresh(), onRefresh()]);
        return;
      }
      const data = await readJson<ActionPayload>(res);
      // No JSON body means the answer never came from this app — a CDN or
      // gateway page stands in for it, and whether the edit landed is unknown.
      // Reload the history rather than guess: a new version appearing in the
      // list is the teacher's answer.
      if (!data) {
        await Promise.all([refresh(), onRefresh()]).catch(() => {});
        update({
          error: `The server did not return a usable answer (HTTP ${res.status}). The request may have taken too long — check the version list before trying again.`,
        });
        return;
      }
      if (!res.ok) {
        update({
          error: data.error ?? "Request failed",
          eventId: data.guardrailEventId ?? null,
        });
        return;
      }
      if (data.chatId) update({ chatId: data.chatId });
      if (data.showVersion)
        update({ selected: data.showVersion, chatId: undefined });
      if (action === "chat" || action === "abort")
        update({ draft: "", answers: {} });
      if (action === "abort") update({ chatId: undefined });
      if (action === "patch")
        update((current) => ({
          patches: [],
          rename: "",
          editing: false,
          previewNonce: current.previewNonce + 1,
        }));
      await Promise.all([refresh(), onRefresh()]);
    } catch (e) {
      update({ error: e instanceof Error ? e.message : "Request failed" });
    } finally {
      inFlight.current = false;
      // The saved transcript has already been reloaded by here, so dropping the
      // live copy swaps one rendering of the same words for the other.
      update({ busy: false, streaming: "", activity: null });
    }
  }
  function stage(id: string, patch: SimulationPatch) {
    update((current) => ({
      patches: coalesceSimulationPatches(current.patches, { id, patch }),
      error: "",
    }));
  }
  function unstage(id: string) {
    update((current) => ({
      patches: current.patches.filter((staged) => staged.id !== id),
    }));
  }
  /**
   * Render a committed formula and paint it back over the LaTeX the teacher
   * typed. The sandbox has no KaTeX of its own, and the app bundle already
   * carries it for the rest of the UI, so rendering here costs nothing extra —
   * and going through the same helper the server uses is what makes the preview
   * honest about what a save will store.
   */
  function paint(edit: SimulationPreviewEdit, latex: string, display: Display) {
    const html = renderSimulationFormulaHtml(latex, display);
    edit.paint(html, latex);
    if (!html)
      update({
        error: `That formula is still staged, but KaTeX cannot render it: ${latex}`,
      });
  }
  /** Turn one committed preview edit into a staged patch. */
  function applyPreviewEdit(edit: SimulationPreviewEdit) {
    switch (edit.kind) {
      // Back to the original wording, or a new formula abandoned before it had
      // any content — either way there is nothing left to save.
      case "text-revert":
      case "formula-drop":
        unstage(edit.token);
        return;
      case "text":
        stage(edit.token, {
          kind: "text",
          before: edit.before,
          after: edit.after,
        });
        return;
      case "formula-delete":
        stage(edit.token, { kind: "formula-delete", index: edit.index });
        return;
      case "formula-edit":
        stage(edit.token, {
          kind: "formula-edit",
          index: edit.index,
          latex: edit.latex,
        });
        paint(edit, edit.latex, edit.display);
        return;
      case "formula-add":
        stage(edit.token, {
          kind: "formula-add",
          latex: edit.latex,
          display: edit.display,
          after: edit.anchor,
        });
        paint(edit, edit.latex, edit.display);
    }
  }
  function startEditing() {
    update({ editing: true, patches: [], error: "" });
  }
  /**
   * Leave edit mode and throw the batch away. The preview is remounted rather
   * than unwound edit by edit: the served document is the source of truth, and
   * reloading it is the only way to be sure nothing half-applied is left on
   * screen.
   */
  function cancelEditing() {
    update((current) => ({
      editing: false,
      patches: [],
      error: "",
      previewNonce: current.previewNonce + 1,
    }));
  }
  async function save() {
    await act("patch");
  }
  function selectVersion(next: number) {
    // Staged patches address formulas and text in one specific version, so they
    // cannot follow the teacher to another branch; the prose draft can.
    update((current) => ({
      selected: next,
      chatId: undefined,
      answers: {},
      rename: "",
      patches: [],
      editing: false,
      previewNonce: current.previewNonce + 1,
    }));
  }
  return {
    ...state,
    chat,
    plan,
    turns,
    current: state.versions.find((v) => v.number === state.selected),
    act,
    stage,
    unstage,
    applyPreviewEdit,
    startEditing,
    cancelEditing,
    save,
    describePatch: (patch: SimulationPatch) =>
      describeSimulationPatch(patch, state.formulas),
    selectVersion,
    update,
  };
}
export type EditorController = ReturnType<typeof useSimulationEditor>;
