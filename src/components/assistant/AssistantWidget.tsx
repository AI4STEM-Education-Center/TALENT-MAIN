"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  History,
  Loader2,
  Paperclip,
  Send,
  Sparkles,
  SquarePen,
  Wrench,
  X,
} from "lucide-react";
import { AiMetricsLine } from "@/components/ai-metrics-line";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readNdjson } from "@/lib/assistant/ndjson";
import type {
  AssistantStreamEvent,
  AssistantTurn,
  ConversationSummary,
  StoredAttachmentRef,
} from "@/lib/assistant/types";
import type { DisplayAiMetrics } from "@/lib/ai-metrics";
import {
  formatBytes,
  prepareAttachment,
  type PreparedAttachment,
} from "./attachment-input";
import { useAssistant } from "./assistant-context";

const MARKDOWN_CLASS =
  "text-sm [&_p]:mb-2 [&_p:last-child]:mb-0 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_h2]:mt-3 [&_h3]:mt-3 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_table]:w-full [&_table]:text-xs [&_th]:border-b [&_th]:border-border [&_th]:px-1 [&_th]:py-1 [&_th]:text-left [&_td]:border-b [&_td]:border-border/50 [&_td]:px-1 [&_td]:py-1";

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

/** One rendered bubble. `pending` marks the assistant turn currently streaming. */
type Bubble = AssistantTurn & {
  pending?: boolean;
  error?: string | null;
  /**
   * User turns: the stored attachments that can be re-rendered inline, kept
   * pre-filtered so the render pass doesn't re-scan every turn's list.
   */
  storedImages?: StoredAttachmentRef[];
  /**
   * Assistant turns: the model/timing stats from the turn's `done` event.
   * Rendered by AiMetricsLine, which draws nothing on the production site — the
   * numbers are a dev-site aid for checking which model answered and how fast.
   */
  stats?: DisplayAiMetrics;
};

/** A tool the assistant is running (or just ran) during the pending turn. */
type ToolActivity = { name: string; label: string; status: "running" | "done" | "error" };

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

  // Abort an in-flight turn if the widget unmounts (navigation, sign-out).
  useEffect(() => () => abortRef.current?.abort(), []);

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

    const fail = (text: string) =>
      setBubbles((prev) =>
        prev.map((bubble, index) =>
          index === prev.length - 1 ? { ...bubble, pending: false, error: text } : bubble
        )
      );

    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message,
          conversationId,
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
          fail(event.message);
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

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label={isTeacher ? "Teaching assistant" : "Study assistant"}
          className="fixed inset-x-2 bottom-2 z-50 flex max-h-[min(80vh,640px)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[26rem]"
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="size-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {isTeacher ? "Teaching assistant" : "Study assistant"}
              </p>
            </div>
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
            {bubbles.length === 0 && (
              <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                {config.greeting}
              </div>
            )}

            {bubbles.map((bubble, index) => (
              <div
                key={index}
                className={cn("flex", bubble.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2",
                    bubble.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  )}
                >
                  {bubble.role === "user" ? (
                    <p className="whitespace-pre-wrap text-sm">{bubble.content}</p>
                  ) : (
                    <div className={MARKDOWN_CLASS} aria-live="polite">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{bubble.content}</ReactMarkdown>
                    </div>
                  )}

                  {bubble.storedImages && bubble.storedImages.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {bubble.storedImages.map((item) => (
                        // eslint-disable-next-line @next/next/no-img-element -- authorized redirect to a signed URL, not a static asset
                        <img
                          key={item.id}
                          src={`/api/assistant/attachments/${item.id}`}
                          alt={item.name}
                          title={item.name}
                          className="size-14 rounded border border-black/10 object-cover"
                        />
                      ))}
                    </div>
                  )}

                  {bubble.attachmentNames && bubble.attachmentNames.length > 0 && (
                    <p className="mt-1 text-xs opacity-80">
                      <Paperclip className="mr-1 inline size-3" />
                      {bubble.attachmentNames.join(", ")}
                    </p>
                  )}

                  {bubble.stats && (
                    <AiMetricsLine
                      metrics={bubble.stats}
                      prefix="Answered by "
                      className="mt-1 block whitespace-normal text-xs text-muted-foreground"
                    />
                  )}

                  {bubble.error && (
                    <p className="mt-1 text-xs text-destructive">{bubble.error}</p>
                  )}

                  {bubble.pending && !bubble.content && !bubble.error && (
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin text-primary" /> Thinking…
                    </span>
                  )}
                </div>
              </div>
            ))}

            {activity.length > 0 && (
              <ul className="space-y-1">
                {activity.map((item) => (
                  <li
                    key={item.name}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    {item.status === "running" ? (
                      <Loader2 className="size-3 animate-spin text-primary" />
                    ) : (
                      <Wrench
                        className={cn(
                          "size-3",
                          item.status === "error" ? "text-destructive" : "text-primary"
                        )}
                      />
                    )}
                    {item.label}
                    {item.status === "error" && " — failed"}
                  </li>
                ))}
              </ul>
            )}
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
                  key={`${attachment.name}-${index}`}
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
        </div>
      )}
    </>
  );
}
