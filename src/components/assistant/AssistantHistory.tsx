"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AssistantConversation } from "./use-assistant-conversation";

/**
 * Short timestamp for a history row: a time for today, a weekday inside the last
 * week, a date beyond that. The list is capped at the retention window, so the
 * date form never has to disambiguate a year.
 */
function formatWhen(iso: string): string {
  const when = new Date(iso);
  const elapsedMs = Date.now() - when.getTime();
  if (elapsedMs < 24 * 60 * 60 * 1000) {
    // react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- history is fetched after mount; SSR and initial hydration render no timestamps
    return when.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (elapsedMs < 7 * 24 * 60 * 60 * 1000) {
    // react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- history is fetched after mount; SSR and initial hydration render no timestamps
    return when.toLocaleDateString(undefined, { weekday: "short" });
  }
  // react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- history is fetched after mount; SSR and initial hydration render no timestamps
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function AssistantHistory({
  conversation,
}: {
  conversation: AssistantConversation;
}) {
  const {
    history,
    loadingConversation,
    historyDays,
    conversationId,
    openConversation,
  } = conversation;
  return (
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
                  item.id === conversationId && "bg-accent",
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
  );
}
