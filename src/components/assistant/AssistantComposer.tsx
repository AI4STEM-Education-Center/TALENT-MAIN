"use client";

import { useRef } from "react";
import { Loader2, Paperclip, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes } from "./attachment-input";
import type { AssistantConversation } from "./use-assistant-conversation";

export function AssistantComposer({
  conversation,
  isTeacher,
}: {
  conversation: AssistantConversation;
  isTeacher: boolean;
}) {
  const {
    attachments,
    preparing,
    addFiles,
    removeAttachment,
    draft,
    setDraft,
    sending,
    send,
    accept,
    attachmentsEnabled,
  } = conversation;
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      {" "}
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
          {attachments.map((attachment) => (
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
              <span className="text-muted-foreground">
                {formatBytes(attachment.bytes)}
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
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
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
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
          disabled={sending || preparing || draft.trim().length === 0}
          aria-label="Send message"
        >
          {sending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </form>
    </>
  );
}
