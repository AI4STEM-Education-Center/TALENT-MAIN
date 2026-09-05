"use client";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { SimulationEditPlan } from "@/lib/simulation-edit";
import {
  describeSimulationPatch,
  type SimulationFormula,
  type SimulationPatch,
} from "@/lib/simulation-patch";
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
/** A staged patch plus a key that survives removing an earlier one. */
export type StagedPatch = { id: string; patch: SimulationPatch };
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
  /** Edits staged in the preview, applied (or sent to chat) as one batch. */
  patches: StagedPatch[];
  assistant: AssistantStatus;
};
function reducer(state: State, patch: Partial<State>) {
  return { ...state, ...patch };
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
    if (!res.ok) throw new Error("Could not load version history");
    const data = await res.json();
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
    update({ busy: true, error: "", eventId: null });
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
      const data = await res.json();
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
      if (action === "patch") update({ patches: [], rename: "" });
      await Promise.all([refresh(), onRefresh()]);
    } catch (e) {
      update({ error: e instanceof Error ? e.message : "Request failed" });
    } finally {
      inFlight.current = false;
      update({ busy: false });
    }
  }
  function stage(patch: SimulationPatch) {
    update({
      patches: [...state.patches, { id: crypto.randomUUID(), patch }],
      error: "",
    });
  }
  function unstage(id: string) {
    update({ patches: state.patches.filter((staged) => staged.id !== id) });
  }
  /** Hand the staged edits to the chat instead, for review alongside prose. */
  function stageToDraft() {
    const lines = state.patches.map((staged) =>
      describeSimulationPatch(staged.patch, state.formulas),
    );
    update({
      draft: [state.draft, ...lines].filter(Boolean).join("\n"),
      patches: [],
    });
  }
  function selectVersion(next: number) {
    // Staged patches address formulas and text in one specific version, so they
    // cannot follow the teacher to another branch; the prose draft can.
    update({
      selected: next,
      chatId: undefined,
      answers: {},
      rename: "",
      patches: [],
    });
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
    stageToDraft,
    describePatch: (patch: SimulationPatch) =>
      describeSimulationPatch(patch, state.formulas),
    selectVersion,
    update,
  };
}
export type EditorController = ReturnType<typeof useSimulationEditor>;
