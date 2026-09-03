"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Loader2, Move, Paperclip, Send, Sparkles, SquarePen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readNdjson } from "@/lib/assistant/ndjson";
import type {
  AssistantStreamEvent,
  AssistantTurn,
  ConversationSummary,
} from "@/lib/assistant/types";
import type { DisplayAiMetrics } from "@/lib/ai-metrics";
import {
  formatBytes,
  prepareAttachment,
  type PreparedAttachment,
} from "./attachment-input";
import {
  clampPanelRect,
  defaultPanelRect,
  forgetPanelRect,
  movePanelRect,
  readStoredPanelRect,
  resizePanelRect,
  storePanelRect,
  type PanelRect,
  type ResizeEdge,
} from "./panel-geometry";
import { useAssistant } from "./assistant-context";
import { AssistantTranscript, type Bubble, type ToolActivity } from "./AssistantTranscript";
import { usePanelDrag } from "./use-panel-drag";

/**
 * Short timestamp for a history row: a time for today, a weekday inside the last
 * week, a date beyond that. The list is capped at the retention window, so the
 * date form never has to disambiguate a year.
 */
function formatWhen(iso: string): string {
  const when = new Date(iso);
  const elapsedMs = Date.now() - when.getTime();
  if (elapsedMs < 24 * 60 * 60 * 1000) {
    return when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (elapsedMs < 7 * 24 * 60 * 60 * 1000) {
    return when.toLocaleDateString(undefined, { weekday: "short" });
  }
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The eight grab targets around the panel. Edges are thin strips inset past the
 * corners, so a corner drag — which resizes both axes at once — always wins the
 * hit test over the two edges it meets.
 */
const RESIZE_HANDLES: { edge: ResizeEdge; className: string }[] = [
  { edge: "n", className: "inset-x-3 top-0 h-1.5 cursor-ns-resize" },
  { edge: "s", className: "inset-x-3 bottom-0 h-1.5 cursor-ns-resize" },
  { edge: "w", className: "inset-y-3 left-0 w-1.5 cursor-ew-resize" },
  { edge: "e", className: "inset-y-3 right-0 w-1.5 cursor-ew-resize" },
  { edge: "nw", className: "left-0 top-0 size-2.5 cursor-nwse-resize" },
  { edge: "ne", className: "right-0 top-0 size-2.5 cursor-nesw-resize" },
  { edge: "sw", className: "bottom-0 left-0 size-2.5 cursor-nesw-resize" },
  { edge: "se", className: "bottom-0 right-0 size-2.5 cursor-nwse-resize" },
];

export function AssistantWidget() {
  const { config, open, setOpen } = useAssistant();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PreparedAttachment[]>([]);
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The transcript this panel is writing to. Minted by the server on the first
  // turn and echoed back on every later one, which is what keeps an exchange
  // landing in one conversation instead of starting a new one per message.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[] | null>(null);
  const [historyDays, setHistoryDays] = useState<number | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Where the panel sits and how big it is. null until the first client-side
  // measurement, and unused on narrow screens, where the panel stays docked
  // across the bottom of the viewport — there is nowhere to drag it to.
  const [rect, setRect] = useState<PanelRect | null>(null);
  const [floating, setFloating] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Abort an in-flight turn if the widget unmounts (navigation, sign-out).
  useEffect(() => () => abortRef.current?.abort(), []);

  // Decide whether there is room to float, restore the remembered geometry, and
  // keep the panel inside the window as it resizes. Measuring in an effect
  // rather than during render keeps the server markup and the first client pass
  // in agreement.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 640px)");
    const sync = () => {
      setFloating(wide.matches);
      if (!wide.matches) return;
      const { innerWidth: vw, innerHeight: vh } = window;
      setRect((prev) =>
        clampPanelRect(prev ?? readStoredPanelRect() ?? defaultPanelRect(vw, vh), vw, vh)
      );
    };
    sync();
    window.addEventListener("resize", sync);
    wide.addEventListener("change", sync);
    return () => {
      window.removeEventListener("resize", sync);
      wide.removeEventListener("change", sync);
    };
  }, []);

  // Object URLs are created per attachment; revoke them when the tray clears.
  useEffect(() => {
    return () => {
      for (const attachment of attachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
    // Intentionally keyed on the array identity: the cleanup runs when the tray
    // is replaced, which is exactly when the previous URLs stop being shown.
  }, [attachments]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles, activity]);

  const accept = (config?.attachmentKinds ?? []).map((kind) => kind.accept).join(",");
  const attachmentsEnabled = (config?.attachmentKinds?.length ?? 0) > 0;
  const maxAttachments = config?.maxAttachments ?? 0;

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!attachmentsEnabled || files.length === 0) return;
      const room = maxAttachments - attachments.length;
      if (room <= 0) {
        setNotice(`You can attach at most ${maxAttachments} file(s) per message.`);
        return;
      }
      const prepared = await Promise.all(files.slice(0, room).map(prepareAttachment));
      const limit = config?.maxAttachmentBytes ?? 0;
      const tooBig = prepared.filter((file) => limit > 0 && file.bytes > limit);
      for (const file of tooBig) {
        if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
      }
      if (tooBig.length > 0) {
        setNotice(
          `${tooBig.map((f) => f.name).join(", ")} exceeded the ${formatBytes(limit)} limit.`
        );
      } else if (files.length > room) {
        setNotice(`Only the first ${room} file(s) were attached.`);
      }
      const kept = prepared.filter((file) => !tooBig.includes(file));
      if (kept.length > 0) setAttachments((prev) => [...prev, ...kept]);
    },
    [attachments.length, attachmentsEnabled, config?.maxAttachmentBytes, maxAttachments]
  );

  // The gesture itself runs outside React — see use-panel-drag.ts. The panel is
  // written once per animation frame instead of once per pointer event, and this
  // component renders once, here, when the gesture ends.
  const commitRect = useCallback((next: PanelRect) => {
    setRect(next);
    // Written once per gesture, not once per frame.
    storePanelRect(next);
  }, []);

  const beginDrag = usePanelDrag({ panelRef, rect, enabled: floating, onCommit: commitRect });
  const beginMove = useMemo(() => beginDrag("move"), [beginDrag]);

  /**
   * The keyboard path to the same two gestures: arrows nudge the panel, Shift
   * takes bigger steps, Alt resizes from the bottom-right corner.
   */
  const nudge = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 48 : 16;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = deltas[event.key];
    if (!delta || !rect) return;
    event.preventDefault();
    const { innerWidth: vw, innerHeight: vh } = window;
    const next = event.altKey
      ? resizePanelRect(rect, "se", delta[0], delta[1], vw, vh)
      : movePanelRect(rect, delta[0], delta[1], vw, vh);
    setRect(next);
    storePanelRect(next);
  };

  /** Back to the bottom-right dock, for a panel dragged somewhere unhelpful. */
  const resetLayout = () => {
    forgetPanelRect();
    setRect(defaultPanelRect(window.innerWidth, window.innerHeight));
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => {
      const target = prev[index];
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  /** Start a fresh transcript. The previous one stays readable under History. */
  const startNewConversation = () => {
    setBubbles([]);
    setActivity([]);
    setNotice(null);
    setConversationId(null);
    setHistoryOpen(false);
  };

  const openHistory = useCallback(async () => {
    setHistoryOpen(true);
    setLoadingConversation(false);
    // Refetched every time rather than cached: the list changes as the user
    // chats, and it is a handful of rows.
    setHistory(null);
    try {
      const res = await fetch("/api/assistant/conversations");
      if (!res.ok) {
        setHistory([]);
        return;
      }
      const data = (await res.json()) as {
        conversations: ConversationSummary[];
        retentionDays: number;
      };
      setHistory(data.conversations);
      setHistoryDays(data.retentionDays);
    } catch {
      setHistory([]);
    }
  }, []);

  const openConversation = useCallback(async (id: string) => {
    setLoadingConversation(true);
    try {
      const res = await fetch(`/api/assistant/conversations/${id}`);
      if (!res.ok) {
        // Aged out between listing and clicking, or signed out. Say so rather
        // than opening a blank panel.
        setNotice("That conversation is no longer available.");
        setHistoryOpen(false);
        return;
      }
      const data = (await res.json()) as { turns: AssistantTurn[] };
      setBubbles(
        data.turns.map((turn) => ({
          role: turn.role,
          content: turn.content,
          attachmentNames: turn.attachmentNames,
          attachmentIds: turn.attachmentIds,
        }))
      );
      setConversationId(id);
      setActivity([]);
      setNotice(null);
      setHistoryOpen(false);
    } catch {
      setNotice("That conversation could not be loaded.");
    } finally {
      setLoadingConversation(false);
    }
  }, []);

  const send = async () => {
    const message = draft.trim();
    if (!message || sending) return;

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

    setBubbles((prev) => [...prev, userBubble, { role: "assistant", content: "", pending: true }]);
    setDraft("");
    setAttachments([]);
    setActivity([]);
    setNotice(null);
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const fail = (text: string, guardrailEventId?: string | null) =>
      setBubbles((prev) =>
        prev.map((bubble, index) =>
          index === prev.length - 1
            ? { ...bubble, pending: false, error: text, guardrailEventId: guardrailEventId ?? null }
            : bubble
        )
      );

    try {
      const res = await fetch("/api/assistant/chat", {
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

      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => null);
        fail(detail?.error ?? "The assistant is unavailable right now.");
        return;
      }

      for await (const event of readNdjson<AssistantStreamEvent>(res.body)) {
        if (event.type === "delta") {
          setBubbles((prev) =>
            prev.map((bubble, index) =>
              index === prev.length - 1
                ? { ...bubble, content: bubble.content + event.text }
                : bubble
            )
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
            const index = prev.findLastIndex((bubble) => bubble.role === "user");
            if (index === -1) return prev;
            const next = [...prev];
            next[index] = {
              ...next[index],
              attachmentIds: event.stored.map((item) => item.id),
              storedImages: event.stored.filter((item) => item.kind === "image"),
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
              index === prev.length - 1 ? { ...bubble, stats } : bubble
            )
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
      abortRef.current = null;
      setSending(false);
      setBubbles((prev) =>
        prev.map((bubble, index) =>
          index === prev.length - 1 ? { ...bubble, pending: false } : bubble
        )
      );
    }
  };

  if (!config?.available) return null;

  const isTeacher = config.audience === "teacher";
  // Narrowed once, so the style below can read `rect` without re-checking it.
  const floatingPanel = floating && rect !== null;

  return (
    <>
      {open && (
        <div
          ref={panelRef}
          // react-doctor-disable-next-line react-doctor/prefer-html-dialog -- this is a docked non-modal chat panel, not a modal; <dialog> would change stacking and focus semantics
          role="dialog"
          aria-label={isTeacher ? "Teaching assistant" : "Study assistant"}
          style={
            floatingPanel
              ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
              : undefined
          }
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden rounded-[var(--radius)] border-[length:var(--border-width)] border-border bg-background [box-shadow:var(--shadow-overlay)]",
            // Narrow screens keep the old docked strip; anywhere with room, the
            // position and size come from `rect` instead.
            floatingPanel ? "max-h-none" : "inset-x-2 bottom-2 max-h-[min(80vh,640px)]",
            // `data-dragging` is set imperatively for the duration of a gesture
            // (globals.css turns off selection and hit-testing under it), so a
            // drag never costs a React render just to change a class.
            floatingPanel && "assistant-panel"
          )}
        >
          <header
            onPointerDown={(event) => {
              // The header buttons keep their clicks; only the bare strip drags.
              if ((event.target as HTMLElement).closest("button")) return;
              beginMove(event);
            }}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest("button")) return;
              resetLayout();
            }}
            className={cn(
              "flex items-center gap-2 border-b border-border px-3 py-2",
              floatingPanel && "cursor-move touch-none"
            )}
          >
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="size-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {isTeacher ? "Teaching assistant" : "Study assistant"}
              </p>
            </div>
            {floatingPanel && (
              <button
                type="button"
                onPointerDown={beginMove}
                onKeyDown={nudge}
                aria-label="Move or resize the assistant panel"
                title="Drag to move · drag an edge to resize · arrow keys move, Alt+arrows resize · double-click the header to reset"
                className="cursor-move touch-none rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Move className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => void (historyOpen ? setHistoryOpen(false) : openHistory())}
              aria-label="Conversation history"
              aria-pressed={historyOpen}
              className={cn(
                "rounded-md p-1.5 transition-colors hover:bg-accent hover:text-foreground",
                historyOpen ? "bg-accent text-foreground" : "text-muted-foreground"
              )}
            >
              <History className="size-4" />
            </button>
            {bubbles.length > 0 && (
              <button
                type="button"
                onClick={startNewConversation}
                aria-label="New conversation"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <SquarePen className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </header>

          {historyOpen && (
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {history === null || loadingConversation ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin text-primary" /> Loading…
                </p>
              ) : history.length === 0 ? (
                <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                  No past conversations yet.
                </p>
              ) : (
                <ul className="space-y-1">
                  {history.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => void openConversation(item.id)}
                        className={cn(
                          "w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent",
                          item.id === conversationId && "bg-accent"
                        )}
                      >
                        <span className="block truncate text-sm">{item.title}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {formatWhen(item.lastMessageAt)} · {item.messageCount} message
                          {item.messageCount === 1 ? "" : "s"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {historyDays !== null && history !== null && history.length > 0 && (
                <p className="mt-3 px-3 text-xs text-muted-foreground">
                  Conversations are shown for {historyDays} day
                  {historyDays === 1 ? "" : "s"}.
                </p>
              )}
            </div>
          )}

          {/*
            Kept mounted while the history list is up rather than swapped out, so
            returning to the conversation returns to the same scroll position.
          */}
          <div
            ref={scrollRef}
            className={cn(
              "flex-1 space-y-3 overflow-y-auto px-3 py-3",
              historyOpen && "hidden"
            )}
          >
            <AssistantTranscript bubbles={bubbles} activity={activity} greeting={config.greeting} />
          </div>

          {notice && (
            <p className="border-t border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
              {notice}
            </p>
          )}

          {attachments.length > 0 && !historyOpen && (
            <ul className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
              {attachments.map((attachment, index) => (
                <li
                  key={attachment.id}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-1 text-xs"
                >
                  {attachment.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local object URL, not a remote asset
                    <img
                      src={attachment.previewUrl}
                      alt=""
                      className="size-6 rounded object-cover"
                    />
                  ) : (
                    <Paperclip className="size-3.5 text-muted-foreground" />
                  )}
                  <span className="max-w-[8rem] truncate">{attachment.name}</span>
                  <span className="text-muted-foreground">{formatBytes(attachment.bytes)}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(index)}
                    aria-label={`Remove ${attachment.name}`}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className={cn(
              "flex items-end gap-2 border-t border-border p-2",
              // The composer belongs to the transcript, not to the history list:
              // hiding it keeps "which conversation would this send to?" from
              // being a question the user has to answer.
              historyOpen && "hidden"
            )}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {attachmentsEnabled && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept={accept}
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void addFiles([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0"
                  aria-label="Attach a file"
                  disabled={sending}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip className="size-4" />
                </Button>
              </>
            )}

            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter adds a line, matching chat convention.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              onPaste={(event) => {
                const files = [...event.clipboardData.files];
                if (files.length > 0 && attachmentsEnabled) {
                  event.preventDefault();
                  void addFiles(files);
                }
              }}
              rows={1}
              maxLength={4000}
              placeholder={
                isTeacher ? "Ask about a class…" : "Ask about your past quizzes…"
              }
              aria-label="Message"
              className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />

            <Button
              type="submit"
              size="icon"
              className="size-9 shrink-0"
              disabled={sending || draft.trim().length === 0}
              aria-label="Send message"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          </form>

          {/*
            Invisible grab strips around the border. The pointer shape is the
            affordance, as it is for a native window; the keyboard equivalent is
            Alt+arrows on the move button in the header.
          */}
          {floatingPanel &&
            RESIZE_HANDLES.map((handle) => (
              // react-doctor-disable-next-line react-doctor/no-static-element-interactions -- pointer-only resize grip; the keyboard path is Alt+arrows on the header's move button
              <div
                key={handle.edge}
                onPointerDown={beginDrag(handle.edge)}
                aria-hidden="true"
                className={cn("absolute touch-none", handle.className)}
              />
            ))}
        </div>
      )}
    </>
  );
}
