"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Lightbulb, Loader2, MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AssistantTranscript,
  type RenderCards,
} from "@/components/assistant/AssistantTranscript";
import {
  SttErrorBanner,
  SttMicButton,
} from "@/components/assistant/SttMicButton";
import { useSttComposer } from "@/components/assistant/use-stt-composer";
import { useOptionalAssistant } from "@/components/assistant/assistant-context";
import { cn } from "@/lib/utils";
import type { CoachActionView } from "@/lib/assistant/coach-types";
import { CoachActionCards } from "./CoachActionCards";
import { CoachQuestionPane } from "./CoachQuestionPane";
import { useCoachChat, type CoachTarget } from "./use-coach-chat";

/**
 * The coach itself: the original question on one side, the chat on the other.
 * Embeddable — the guided post-quiz review puts it straight on the page, and
 * the "Chat with assistant" dialog wraps the same component. Give it a bounded
 * height (it fills its parent and scrolls internally).
 */
export function CoachWorkspace({
  target,
  onEngaged,
  className,
}: {
  target: CoachTarget;
  /** Told once the student has written (or had saved) their first message. */
  onEngaged?: (engaged: boolean) => void;
  className?: string;
}) {
  const assistant = useOptionalAssistant();
  const sttEnabled = assistant?.config?.sttEnabled !== false;
  const chat = useCoachChat(target, { onEngaged });
  const {
    load,
    bubbles,
    conversationId,
    hasUserTurn,
    updateCardInteraction,
    activity,
    draft,
    setDraft,
    sending,
    sendText,
  } = chat;

  const stt = useSttComposer({
    draft,
    setDraft,
    onSend: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setDraft("");
      await sendText(trimmed);
    },
    disabled: sending,
    surface: "wrong_answer_coach",
  });

  const canSend =
    !sending &&
    !stt.isBusy &&
    (draft.trim().length > 0 || stt.isRecording || stt.state === "connecting");

  const renderCards = useCallback<RenderCards>(
    (cards: CoachActionView[]) => (
      <CoachActionCards
        actions={cards}
        target={target}
        conversationId={conversationId}
        source="coach"
        onReport={(message) => void sendText(message)}
        onInteractionSaved={updateCardInteraction}
      />
    ),
    [target, conversationId, sendText, updateCardInteraction],
  );

  if (load.status === "loading") {
    return (
      <div
        className={cn("flex flex-1 items-center justify-center p-6", className)}
        role="status"
      >
        <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
        <span className="sr-only">Loading the question</span>
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <p role="alert" className={cn("p-6 text-sm text-destructive", className)}>
        {load.message}
      </p>
    );
  }

  return (
    // Stacked on phones (question on top, capped so the chat keeps room), side
    // by side from md up. The question pane scrolls on its own and is never
    // unmounted while chatting, so the original question stays visible.
    <div className={cn("flex min-h-0 flex-1 flex-col md:flex-row", className)}>
      <div className="max-h-[34dvh] shrink-0 overflow-y-auto border-b bg-muted/20 p-4 md:max-h-none md:w-2/5 md:border-r md:border-b-0">
        <CoachQuestionPane question={load.question} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex-1 space-y-3 overflow-y-auto p-4"
          role="log"
          aria-label="Conversation with the assistant"
        >
          <AssistantTranscript
            bubbles={bubbles}
            activity={activity}
            greeting={undefined}
            renderCards={renderCards}
          />
        </div>
        {!hasUserTurn && !sending && (
          <div
            role="note"
            className="flex items-start gap-2.5 border-t border-primary/15 bg-primary/[0.04] px-4 py-3"
          >
            <Lightbulb
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden
            />
            <p className="text-xs leading-relaxed text-foreground/80">
              <span className="font-semibold text-foreground">
                Share your thoughts first
              </span>{" "}
              — describe how you approached this question or where you got
              stuck, and the coach will tailor follow-up options to what you
              need. You can type or use the mic.
            </p>
          </div>
        )}
        <SttErrorBanner error={stt.error} onDismiss={stt.clearError} />
        <form
          className="flex items-end gap-2 border-t p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void stt.submitOrFinalizeAndSend();
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => stt.handleDraftChange(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter adds a line, as in the assistant widget.
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void stt.submitOrFinalizeAndSend();
              }
            }}
            rows={2}
            maxLength={4000}
            placeholder={
              hasUserTurn
                ? "Reply to the coach…"
                : "How did you approach this question? Where did you get stuck?"
            }
            aria-label="Your message"
            className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          />
          {sttEnabled && (
            <SttMicButton
              state={stt.state}
              disabled={sending}
              onToggle={() => void stt.toggleStt()}
            />
          )}
          <Button
            type="submit"
            size="icon"
            className="size-9 shrink-0"
            disabled={!canSend}
            aria-label="Send message"
          >
            {sending || stt.isBusy ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Send aria-hidden />
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}

/**
 * "Chat with assistant" on one missed question: a button that opens a dialog
 * with the original question on one side and a coach chat on the other. The
 * dialog mounts only while open, so nothing is fetched until a student asks.
 */
export function WrongAnswerCoachButton({
  attemptId,
  questionNumber,
}: {
  attemptId: string;
  questionNumber: number;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Stable across the parent's re-renders (the results page polls), so the open
  // dialog's transcript is not re-rendered for nothing.
  const target = useMemo<CoachTarget>(
    () => ({ attemptId, questionNumber }),
    [attemptId, questionNumber],
  );
  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        aria-haspopup="dialog"
        aria-label={`Chat with assistant about question ${questionNumber}`}
        onClick={() => setOpen(true)}
      >
        <MessageCircle aria-hidden /> Chat with assistant
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus();
            }}
            // Closing mid-experiment loses nothing (the server keeps the
            // chat), but a stray click on the dimmed page should not dismiss it.
            onInteractOutside={(event) => event.preventDefault()}
            className="flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[88dvh] sm:w-[94vw] sm:max-w-5xl sm:rounded-lg sm:border"
          >
            <DialogHeader className="border-b p-4 pr-12">
              <DialogTitle>
                Question {questionNumber}: let&apos;s talk it through
              </DialogTitle>
              <DialogDescription>
                Chat with the assistant about this question. The question stays
                visible while you chat.
              </DialogDescription>
            </DialogHeader>
            <CoachWorkspace
              key={`${attemptId}:${questionNumber}`}
              target={target}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/**
 * The button, shown only when the student assistant is switched on for this
 * student — the coach rides on it, so an admin turning the assistant off turns
 * the coach off too. Reads the availability the dashboard already fetched.
 */
export function WrongAnswerCoachSlot({
  attemptId,
  questionNumber,
}: {
  attemptId: string;
  questionNumber: number;
}) {
  const assistant = useOptionalAssistant();
  if (!assistant?.config?.available || assistant.config.audience !== "student")
    return null;
  return (
    <WrongAnswerCoachButton
      attemptId={attemptId}
      questionNumber={questionNumber}
    />
  );
}
