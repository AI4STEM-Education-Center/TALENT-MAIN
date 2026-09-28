"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Archive, Database, Paperclip, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AssistantTurn } from "@/lib/assistant/types";

const MARKDOWN_CLASS =
  "text-sm [&_p]:mb-2 [&_p:last-child]:mb-0 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_table]:w-full [&_table]:text-xs [&_th]:border-b [&_th]:border-border [&_th]:px-1 [&_th]:py-1 [&_th]:text-left [&_td]:border-b [&_td]:border-border/50 [&_td]:px-1 [&_td]:py-1";

type ConversationRow = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  audience: string;
  title: string;
  messageCount: number;
  createdAt: string;
  lastMessageAt: string;
  archived: boolean;
};

export type ListResponse = {
  rows: ConversationRow[];
  total: number;
};

type TranscriptResponse = ConversationRow & {
  turns: AssistantTurn[];
  transcriptUnavailable: boolean;
};

export function TierBadge({ archived }: { archived: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        archived
          ? "bg-muted text-muted-foreground"
          : "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      )}
      title={
        archived
          ? "Archived: the transcript lives in object storage"
          : "Live: the transcript is still in the database and is full-text searchable"
      }
    >
      {archived ? (
        <Archive className="size-3" />
      ) : (
        <Database className="size-3" />
      )}
      {archived ? "Archived" : "Live"}
    </span>
  );
}

export function TranscriptDialog({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const openerRef = useRef<HTMLElement | null>(null);
  const [data, setData] = useState<
    | (Omit<TranscriptResponse, "turns"> & {
        turns: (AssistantTurn & { key: string })[];
      })
    | null
  >(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/assistants/conversations/${conversationId}`,
        );
        if (!res.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const body = (await res.json()) as TranscriptResponse;
        if (!cancelled)
          setData({
            ...body,
            turns: body.turns.map((turn) => ({
              ...turn,
              key: crypto.randomUUID(),
            })),
          });
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={() => {
          openerRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // The table opens this controlled dialog without a DialogTrigger.
          // Return keyboard users to the row they selected.
          if (openerRef.current?.isConnected) openerRef.current.focus();
        }}
        className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-hidden rounded-xl p-0"
      >
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-semibold">
              {data?.title ?? "Transcript"}
            </DialogTitle>
            {data && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {data.userName} · {data.userEmail} · {data.audience} assistant ·{" "}
                {new Date(data.createdAt).toLocaleString()}
              </p>
            )}
          </div>
          {data && <TierBadge archived={data.archived} />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transcript"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {failed && (
            <p className="text-sm text-destructive">
              This transcript could not be loaded.
            </p>
          )}
          {!failed && !data && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {data?.transcriptUnavailable && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              The conversation record exists, but its archived transcript could
              not be read from object storage. This is a storage problem, not an
              empty conversation.
            </p>
          )}
          {data?.turns.map((turn) => (
            <div
              key={turn.key}
              className={cn(
                "flex",
                turn.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2",
                  turn.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {turn.role === "user" ? (
                  <p className="whitespace-pre-wrap text-sm">{turn.content}</p>
                ) : (
                  <div className={MARKDOWN_CLASS}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {turn.content}
                    </ReactMarkdown>
                  </div>
                )}
                {turn.attachmentNames && turn.attachmentNames.length > 0 && (
                  <p className="mt-1 text-xs opacity-80">
                    <Paperclip className="mr-1 inline size-3" />
                    {turn.attachmentNames.join(", ")}
                  </p>
                )}
              </div>
            </div>
          ))}
          {data && !data.transcriptUnavailable && data.turns.length === 0 && (
            <p className="text-sm text-muted-foreground">
              This conversation has no turns.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
