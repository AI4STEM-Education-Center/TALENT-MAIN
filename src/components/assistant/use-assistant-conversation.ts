"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readNdjson } from "@/lib/assistant/ndjson";
import type {
  AssistantConversationDetail,
  AssistantStreamEvent,
  AssistantTurn,
  ConversationSummary,
} from "@/lib/assistant/types";
import type { CoachHistoryContext } from "@/lib/assistant/coach-types";
import {
  withCardInteraction,
  type CardInteraction,
} from "@/components/student/coach/card-interaction";
import type { DisplayAiMetrics } from "@/lib/ai-metrics";
import type { Bubble, ToolActivity } from "./AssistantTranscript";
import type { WidgetConfig } from "./assistant-context";
import { useAssistantAttachments } from "./use-assistant-attachments";

export function useAssistantConversation(config: WidgetConfig | null) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The transcript this panel is writing to. Minted by the server on the first
  // turn and echoed back on every later one, which is what keeps an exchange
  // landing in one conversation instead of starting a new one per message.
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Set while the open transcript is a wrong-answer coach conversation: its
  // question (for the context drawer) and where follow-ups must be sent.
  const [coachContext, setCoachContext] = useState<CoachHistoryContext | null>(
    null,
  );
  // Set when the open transcript can be read but not continued (e.g. a coach
  // chat whose quiz's answer-key policy changed): the reason the server gave.
  const [readOnly, setReadOnly] = useState<{ reason: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[] | null>(null);
  const [historyDays, setHistoryDays] = useState<number | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);
  const conversationAbortRef = useRef<AbortController | null>(null);

  // Abort an in-flight turn if the widget unmounts (navigation, sign-out).
  useEffect(
    () => () => {
      abortRef.current?.abort();
      historyAbortRef.current?.abort();
      conversationAbortRef.current?.abort();
    },
    [],
  );

  const cancelTurn = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    conversationAbortRef.current?.abort();
    conversationAbortRef.current = null;
    setSending(false);
    setLoadingConversation(false);
    setBubbles((current) =>
      current.map((bubble) => ({ ...bubble, pending: false })),
    );
  }, []);

  const accept = (config?.attachmentKinds ?? [])
    .map((kind) => kind.accept)
    .join(",");
  const attachmentsEnabled = (config?.attachmentKinds?.length ?? 0) > 0;
  const {
    attachments,
    preparing,
    addFiles,
    remove: removeAttachment,
    clear: clearAttachments,
  } = useAssistantAttachments({
    enabled: attachmentsEnabled,
    maxAttachments: config?.maxAttachments ?? 0,
    maxBytes: config?.maxAttachmentBytes ?? 0,
    onNotice: setNotice,
  });

  /** Start a fresh transcript. The previous one stays readable under History. */
  const startNewConversation = () => {
    cancelTurn();
    clearAttachments();
    setDraft("");
    setBubbles([]);
    setActivity([]);
    setNotice(null);
    setConversationId(null);
    setCoachContext(null);
    setReadOnly(null);
    setHistoryOpen(false);
  };

  /** Record a card interaction on the open transcript as soon as it happens. */
  const updateCardInteraction = useCallback(
    (cardId: string | undefined, interaction: CardInteraction) => {
      if (!cardId) return;
      setBubbles((prev) => withCardInteraction(prev, cardId, interaction));
    },
    [],
  );

  const openHistory = useCallback(async () => {
    conversationAbortRef.current?.abort();
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setHistoryOpen(true);
    setLoadingConversation(false);
    // Refetched every time rather than cached: the list changes as the user
    // chats, and it is a handful of rows.
    setHistory(null);
    try {
      const res = await fetch("/api/assistant/conversations", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setHistory([]);
        return;
      }
      const data = (await res.json()) as {
        conversations: ConversationSummary[];
        retentionDays: number;
      };
      if (controller.signal.aborted) return;
      setHistory(data.conversations);
      setHistoryDays(data.retentionDays);
    } catch {
      if (controller.signal.aborted) return;
      setHistory([]);
    }
  }, []);

  const openConversation = useCallback(
    async (id: string) => {
      cancelTurn();
      clearAttachments();
      setDraft("");
      const controller = new AbortController();
      conversationAbortRef.current = controller;
      setLoadingConversation(true);
      try {
        const res = await fetch(`/api/assistant/conversations/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          // Aged out between listing and clicking, or signed out. Say so rather
          // than opening a blank panel.
          setNotice("That conversation is no longer available.");
          setHistoryOpen(false);
          return;
        }
        const data = (await res.json()) as AssistantConversationDetail;
        if (controller.signal.aborted) return;
        const coach = data.coach ?? null;
        const saved: Bubble[] = data.turns.map((turn) => ({
          role: turn.role,
          content: turn.content,
          attachmentNames: turn.attachmentNames,
          attachmentIds: turn.attachmentIds,
          ...(turn.cards?.length ? { cards: turn.cards } : {}),
        }));
        // The coach's opening line is a static greeting, not a stored turn;
        // put it back so the saved conversation reads from the beginning.
        setBubbles(
          coach
            ? [{ role: "assistant", content: coach.opening }, ...saved]
            : saved,
        );
        setCoachContext(coach);
        setReadOnly(
          data.readOnly
            ? {
                reason:
                  data.readOnlyReason ??
                  "This conversation can no longer be continued.",
              }
            : null,
        );
        setConversationId(id);
        setActivity([]);
        setNotice(null);
        setHistoryOpen(false);
      } catch {
        if (!controller.signal.aborted)
          setNotice("That conversation could not be loaded.");
      } finally {
        // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- reset is in finally; an aborted request must not clear its successor’s loading state
        if (!controller.signal.aborted) setLoadingConversation(false);
      }
    },
    [cancelTurn, clearAttachments],
  );

  const send = async (overrideText?: string) => {
    const message = (overrideText ?? draft).trim();
    if (
      !message ||
      readOnly ||
      abortRef.current ||
      loadingConversation ||
      preparing
    )
      return;

    const outgoing = attachments;
    const userBubble: Bubble = {
      role: "user",
      content: message,
      attachmentNames: outgoing.map((file) => file.name),
    };
    // A fallback copy of the transcript BEFORE this turn. The server replays its
    // own stored history when it has one and only falls back to this, so it is
    // sent for the case where persistence is unavailable — not as the source of
    // truth it used to be.
    const fallbackHistory: AssistantTurn[] = bubbles.map((bubble) => ({
      role: bubble.role,
      content: bubble.content,
      attachmentNames: bubble.attachmentNames,
      // Sending the ids back is what lets the server re-read those files, so an
      // image stays discussable for as long as it is retained.
      attachmentIds: bubble.attachmentIds,
    }));

    setBubbles((prev) => [
      ...prev,
      userBubble,
      { role: "assistant", content: "", pending: true },
    ]);
    setDraft("");
    clearAttachments();
    setActivity([]);
    setNotice(null);
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const fail = (text: string, guardrailEventId?: string | null) =>
      setBubbles((prev) =>
        prev.map((bubble, index) =>
          index === prev.length - 1
            ? {
                ...bubble,
                pending: false,
                error: text,
                guardrailEventId: guardrailEventId ?? null,
              }
            : bubble,
        ),
      );

    try {
      // A reopened coach conversation keeps talking to the coach about its
      // question; the server finds the same transcript from the question.
      const res = coachContext
        ? await fetch("/api/assistant/coach/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              message,
              attemptId: coachContext.attemptId,
              questionNumber: coachContext.questionNumber,
            }),
          })
        : await fetch("/api/assistant/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              message,
              // Omitted rather than sent as null on the first turn of a conversation:
              // the field is optional server-side, and a null would be rejected.
              conversationId: conversationId ?? undefined,
              history: fallbackHistory,
              attachments: outgoing.map(({ name, mimeType, dataBase64 }) => ({
                name,
                mimeType,
                dataBase64,
              })),
            }),
          });

      if (controller.signal.aborted) return;
      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => null);
        if (controller.signal.aborted) return;
        fail(detail?.error ?? "The assistant is unavailable right now.");
        return;
      }

      for await (const event of readNdjson<AssistantStreamEvent>(res.body)) {
        if (controller.signal.aborted) break;
        if (event.type === "delta") {
          setBubbles((prev) =>
            prev.map((bubble, index) =>
              index === prev.length - 1
                ? { ...bubble, content: bubble.content + event.text }
                : bubble,
            ),
          );
        } else if (event.type === "action") {
          setBubbles((prev) =>
            prev.map((bubble, index) =>
              index === prev.length - 1
                ? { ...bubble, cards: [...(bubble.cards ?? []), event.action] }
                : bubble,
            ),
          );
        } else if (event.type === "tool") {
          setActivity((prev) => {
            const existing = prev.findIndex((item) => item.name === event.name);
            if (existing === -1) return [...prev, { ...event }];
            const next = [...prev];
            next[existing] = { ...next[existing], status: event.status };
            return next;
          });
        } else if (event.type === "conversation") {
          setConversationId(event.id);
        } else if (event.type === "attachments") {
          // Attach the ids to the user turn they belong to — the last user
          // bubble, since the pending assistant bubble sits after it.
          setBubbles((prev) => {
            const index = prev.findLastIndex(
              (bubble) => bubble.role === "user",
            );
            if (index === -1) return prev;
            const next = [...prev];
            next[index] = {
              ...next[index],
              attachmentIds: event.stored.map((item) => item.id),
              storedImages: event.stored.filter(
                (item) => item.kind === "image",
              ),
            };
            return next;
          });
        } else if (event.type === "done") {
          const stats: DisplayAiMetrics = {
            model: event.model,
            provider: event.provider,
            serviceTier: event.serviceTier,
            thinkingLevel: event.thinkingLevel,
            ttftMs: event.ttftMs,
            generationMs: event.generationMs,
            totalMs: event.totalMs,
            tokens: event.tokens,
            tokensEstimated: event.tokensEstimated,
          };
          setBubbles((prev) =>
            prev.map((bubble, index) =>
              index === prev.length - 1 ? { ...bubble, stats } : bubble,
            ),
          );
        } else if (event.type === "error") {
          fail(event.message, event.guardrailEventId);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        fail("The connection dropped before the answer finished.");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- this finally resets only the turn that still owns the transcript
        setSending(false);
        setBubbles((prev) =>
          prev.map((bubble, index) =>
            index === prev.length - 1 ? { ...bubble, pending: false } : bubble,
          ),
        );
      }
    }
  };

  return {
    bubbles,
    activity,
    notice,
    conversationId,
    coachContext,
    readOnly: readOnly !== null,
    readOnlyReason: readOnly?.reason ?? null,
    updateCardInteraction,
    historyOpen,
    setHistoryOpen,
    history,
    historyDays,
    loadingConversation,
    startNewConversation,
    openHistory,
    openConversation,
    attachments,
    preparing,
    addFiles,
    removeAttachment,
    draft,
    setDraft,
    sending,
    send,
    accept,
    // The coach endpoint takes text only.
    attachmentsEnabled: attachmentsEnabled && !coachContext,
    sttEnabled: config?.sttEnabled !== false,
  };
}

export type AssistantConversation = ReturnType<typeof useAssistantConversation>;
