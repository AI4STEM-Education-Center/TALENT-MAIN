"use client";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { SimulationEditPlan } from "@/lib/simulation-edit";
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
  });
  const inFlight = useRef(false);
  if (version !== state.lastLiveVersion)
    update({
      lastLiveVersion: version,
      selected: version,
      chatId: undefined,
      answers: {},
    });
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/simulations/${id}/edit`);
    if (!res.ok) throw new Error("Could not load version history");
    const data = await res.json();
    update({ versions: data.versions, chats: data.chats });
  }, [id]);
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
          name: state.rename,
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
      await Promise.all([refresh(), onRefresh()]);
    } catch (e) {
      update({ error: e instanceof Error ? e.message : "Request failed" });
    } finally {
      inFlight.current = false;
      update({ busy: false });
    }
  }
  function textEdited(before: string, after: string) {
    update({
      draft: `${state.draft}${state.draft ? "\n" : ""}Replace text ${JSON.stringify(before)} with ${JSON.stringify(after)}.`,
    });
  }
  function selectVersion(selected: number) {
    update({ selected, chatId: undefined, answers: {}, draft: "", rename: "" });
  }
  return {
    ...state,
    chat,
    plan,
    turns,
    current: state.versions.find((v) => v.number === state.selected),
    act,
    textEdited,
    selectVersion,
    update,
  };
}
export type EditorController = ReturnType<typeof useSimulationEditor>;
