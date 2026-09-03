"use client";

/**
 * The message list, split out of the widget and memoized per bubble.
 *
 * Rendering a bubble means running ReactMarkdown over it, which is the most
 * expensive thing the panel does. Inline in the widget, every unrelated state
 * change re-ran all of them: a keystroke in the composer, a tool-activity row,
 * and — before the drag rewrite — every single pointer event of a drag.
 *
 * With the list memoized on its own inputs and each bubble memoized on its own
 * content, a streaming reply re-renders only the bubble receiving the tokens,
 * and typing re-renders nothing here at all.
 */

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Paperclip, Wrench } from "lucide-react";
import { AiMetricsLine } from "@/components/ai-metrics-line";
import { GuardrailFeedbackButton } from "@/components/guardrails/GuardrailFeedbackButton";
import { cn } from "@/lib/utils";
import type { AssistantTurn, StoredAttachmentRef } from "@/lib/assistant/types";
import type { DisplayAiMetrics } from "@/lib/ai-metrics";

const MARKDOWN_CLASS =
  "text-sm [&_p]:mb-2 [&_p:last-child]:mb-0 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_h2]:mt-3 [&_h3]:mt-3 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_table]:w-full [&_table]:text-xs [&_th]:border-b [&_th]:border-border [&_th]:px-1 [&_th]:py-1 [&_th]:text-left [&_td]:border-b [&_td]:border-border/50 [&_td]:px-1 [&_td]:py-1";

/** One rendered bubble. `pending` marks the assistant turn currently streaming. */
export type Bubble = AssistantTurn & {
  pending?: boolean;
  error?: string | null;
  /**
   * Set only when a guardrail refused the turn: lets the error line offer a way
   * to report it as a false positive, which is otherwise a dead end for the
   * user — the message never says which check fired.
   */
  guardrailEventId?: string | null;
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
export type ToolActivity = { name: string; label: string; status: "running" | "done" | "error" };

const MessageBubble = memo(function MessageBubble({ bubble }: { bubble: Bubble }) {
  const isUser = bubble.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
        )}
      >
        {isUser ? (
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
          <div className="mt-1 space-y-1">
            <p className="text-xs text-destructive">{bubble.error}</p>
            <GuardrailFeedbackButton eventId={bubble.guardrailEventId} className="text-destructive" />
          </div>
        )}

        {bubble.pending && !bubble.content && !bubble.error && (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-primary" /> Thinking…
          </span>
        )}
      </div>
    </div>
  );
});

export const AssistantTranscript = memo(function AssistantTranscript({
  bubbles,
  activity,
  greeting,
}: {
  bubbles: Bubble[];
  activity: ToolActivity[];
  greeting: string | undefined;
}) {
  return (
    <>
      {bubbles.length === 0 && (
        <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          {greeting}
        </div>
      )}

      {bubbles.map((bubble, index) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- bubbles is append-only; entries are never inserted, removed, or reordered
        <MessageBubble key={index} bubble={bubble} />
      ))}

      {activity.length > 0 && (
        <ul className="space-y-1">
          {activity.map((item) => (
            <li key={item.name} className="flex items-center gap-2 text-xs text-muted-foreground">
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
    </>
  );
});
