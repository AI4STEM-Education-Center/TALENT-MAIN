"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { readNdjson } from "@/lib/assistant/ndjson";
import type { AssistantStreamEvent } from "@/lib/assistant/types";
import type {
  CoachActionView,
  CoachQuestionView,
  CoachSessionView,
} from "@/lib/assistant/coach-types";
import { withCardInteraction, type CardInteraction } from "./card-interaction";
import type { DisplayAiMetrics } from "@/lib/ai-metrics";
import type {
  Bubble,
  ToolActivity,
} from "@/components/assistant/AssistantTranscript";

export type CoachTarget = { attemptId: string; questionNumber: number };

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; question: CoachQuestionView };

/**
 * State for one coach session. Mirrors useAssistantConversation's turn handling
 * (same NDJSON stream, same bubble shape) but is scoped to one verified
 * question: the server owns the conversation and resolves it from the target,
 * so the id kept here is only what card interactions are filed under.
 */
export function useCoachChat(
  target: CoachTarget,
  {
    onEngaged,
  }: {
    /** Told when the student has a turn: a saved one on load, or a new one. */
    onEngaged?: (engaged: boolean) => void;
  } = {},
) {
  const reportEngaged = useEffectEvent(() => onEngaged?.(true));
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const { attemptId, questionNumber } = target;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/assistant/coach?attemptId=${encodeURIComponent(attemptId)}&questionNumber=${questionNumber}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          if (controller.signal.aborted) return;
          setLoad({
            status: "error",
            message: detail?.error ?? "The assistant is unavailable right now.",
          });
          return;
        }
        const data = (await res.json()) as CoachSessionView;
        if (controller.signal.aborted) return;
        // The opening line is the server's static greeting, not a stored turn,
        // so it is always the first bubble — before any saved conversation.
        setBubbles([
          { role: "assistant", content: data.opening },
          ...data.turns.map<Bubble>((turn) => ({
            role: turn.role,
            content: turn.content,
            ...(turn.actions.length > 0 ? { cards: turn.actions } : {}),
          })),
        ]);
        setConversationId(data.conversationId ?? null);
        if (data.turns.some((turn) => turn.role === "user")) reportEngaged();
        setLoad({ status: "ready", question: data.question });
      } catch {
        if (controller.signal.aborted) return;
        setLoad({
          status: "error",
          message: "The assistant could not be reached.",
        });
      }
    })();
    return () => controller.abort();
  }, [attemptId, questionNumber]);

  // Abort an in-flight turn if the dialog closes mid-answer.
  useEffect(() => () => abortRef.current?.abort(), []);

  const sendText = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || abortRef.current) return;

      onEngaged?.(true);
      setBubbles((prev) => [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: "", pending: true },
      ]);
      setActivity([]);
      setSending(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const fail = (error: string, guardrailEventId?: string | null) =>
        setBubbles((prev) =>
          prev.map((bubble, index) =>
            index === prev.length - 1
              ? {
                  ...bubble,
                  pending: false,
                  error,
                  guardrailEventId: guardrailEventId ?? null,
                }
              : bubble,
          ),
        );

      try {
        const res = await fetch("/api/assistant/coach/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ message: text, attemptId, questionNumber }),
        });
        if (controller.signal.aborted) return;
        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => null);
          if (controller.signal.aborted) return;
          fail(detail?.error ?? "The assistant is unavailable right now.");
          return;
        }

        let completed = false;
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
          } else if (event.type === "tool") {
            setActivity((prev) => {
              const at = prev.findIndex((item) => item.name === event.name);
              if (at === -1) return [...prev, { ...event }];
              const next = [...prev];
              next[at] = { ...next[at], status: event.status };
              return next;
            });
          } else if (event.type === "conversation") {
            setConversationId(event.id);
          } else if (event.type === "action") {
            const card: CoachActionView = event.action;
            setBubbles((prev) =>
              prev.map((bubble, index) =>
                index === prev.length - 1
                  ? { ...bubble, cards: [...(bubble.cards ?? []), card] }
                  : bubble,
              ),
            );
          } else if (event.type === "done") {
            completed = true;
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
            completed = true;
            fail(event.message, event.guardrailEventId);
          }
        }
        if (!completed && !controller.signal.aborted) {
          fail("The connection dropped before the answer finished.");
        }
      } catch {
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
              index === prev.length - 1
                ? { ...bubble, pending: false }
                : bubble,
            ),
          );
        }
      }
    },
    [attemptId, questionNumber, onEngaged],
  );

  const send = useCallback(() => {
    const message = draft;
    if (!message.trim() || abortRef.current) return;
    setDraft("");
    void sendText(message);
  }, [draft, sendText]);

  /** Record a card interaction on the transcript as soon as it happens. */
  const updateCardInteraction = useCallback(
    (cardId: string | undefined, interaction: CardInteraction) => {
      if (!cardId) return;
      setBubbles((prev) => withCardInteraction(prev, cardId, interaction));
    },
    [],
  );

  const hasUserTurn = bubbles.some((bubble) => bubble.role === "user");

  return {
    load,
    bubbles,
    conversationId,
    hasUserTurn,
    updateCardInteraction,
    activity,
    draft,
    setDraft,
    sending,
    send,
    sendText,
  };
}
