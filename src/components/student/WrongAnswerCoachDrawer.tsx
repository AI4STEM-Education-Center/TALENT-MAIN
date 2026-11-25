"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageSquare,
  RotateCcw,
  Send,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { MathText } from "@/components/ui/math-text";
import { COACH_MAX_EXPLANATION_CHARS } from "@/lib/wrong-answer-coach-messages";
import type {
  StructuredTutoringMessage,
  StudentCoachSessionView,
} from "@/lib/wrong-answer-coach-types";

export interface WrongAnswerCoachPanelProps {
  attemptId: string;
  questionId: string;
  questionNumber: number;
  /** "inline" renders a full header bar inside a card; "drawer" omits it because SheetHeader renders the title. */
  variant?: "inline" | "drawer";
  /** Fires whenever the session state changes (e.g. to refresh eligibility badges). */
  onStateChange?: () => void;
  /** Fires with `true` once the student has submitted at least one turn or has an active/completed session. */
  onEngaged?: (engaged: boolean) => void;
  /** Optional status listener so the drawer wrapper can show step pills & badges in SheetHeader. */
  onSessionLoaded?: (session: StudentCoachSessionView | null) => void;
}

interface WrongAnswerCoachDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attemptId: string;
  questionId: string;
  questionNumber: number;
  onStateChange?: () => void;
}

const STEP_LABELS = [
  "1. Your thinking",
  "2. Similar question",
  "3. One more check",
  "4. Explanation",
] as const;

function currentStepIndex(state: StudentCoachSessionView["state"]): number {
  switch (state) {
    case "AWAITING_EXPLANATION":
    case "CLASSIFYING_FAILED":
      return 0;
    case "AWAITING_SECOND_QUESTION":
      return 1;
    case "AWAITING_HELDOUT_QUESTION":
      return 2;
    case "GENERATING_TUTORING":
    case "COMPLETED":
      return 3;
    case "INCOMPLETE":
      return -1;
  }
}

function isSessionEngaged(session: StudentCoachSessionView): boolean {
  return (
    session.state !== "AWAITING_EXPLANATION" ||
    session.messages.some((m) => m.role === "student")
  );
}

function StepPills({ state }: { state: StudentCoachSessionView["state"] }) {
  const activeStep = currentStepIndex(state);
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {STEP_LABELS.map((label, idx) => (
        <span
          key={label}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
            idx < activeStep
              ? "border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-400"
              : idx === activeStep
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground"
          }`}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function StatusBadge({ state }: { state: StudentCoachSessionView["state"] }) {
  if (state === "COMPLETED") {
    return <Badge variant="success">Completed</Badge>;
  }
  if (state === "INCOMPLETE") {
    return <Badge variant="secondary">Ended early</Badge>;
  }
  return null;
}

function TutoringMessageCard({
  structured,
}: {
  structured: StructuredTutoringMessage;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-green-300/70 bg-green-50/70 p-3 dark:border-green-800 dark:bg-green-950/30">
        <p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-400">
          Correct answer
        </p>
        <p className="mt-1 text-sm font-medium text-foreground">
          <MathText text={structured.correctAnswerText} />
        </p>
      </div>
      <div className="space-y-2 text-sm leading-relaxed">
        {structured.bodyParagraphs.map((para, idx) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- read-only server-rendered tutoring paragraphs
          <p key={`${idx}-${para.slice(0, 24)}`}>
            <MathText text={para} />
          </p>
        ))}
      </div>
      {structured.keyPoints && structured.keyPoints.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {structured.keyPoints.map((kp, idx) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- read-only server-rendered key points
            <li key={`${idx}-${kp.slice(0, 24)}`}>
              <MathText text={kp} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OriginalQuestionCard({
  session,
}: {
  session: StudentCoachSessionView;
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-3.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Original question
      </p>
      <p className="text-sm font-medium">
        <MathText text={session.originalQuestion.text} />
      </p>
      <div className="flex items-start gap-2 rounded bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
        <XCircle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          <strong>Your answer:</strong>{" "}
          <MathText text={session.originalQuestion.chosenOptionText} />
        </span>
      </div>
      {session.state === "COMPLETED" &&
        session.originalQuestion.correctOptionText && (
          <div className="flex items-start gap-2 rounded bg-green-50 px-2.5 py-1.5 text-xs text-green-700 dark:bg-green-950/30 dark:text-green-400">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <strong>Correct answer:</strong>{" "}
              <MathText text={session.originalQuestion.correctOptionText} />
            </span>
          </div>
        )}
    </div>
  );
}

function ActiveMcqCard({
  mcq,
  submitting,
  selectedToken,
  onSelectToken,
  showFreeText,
  onToggleFreeText,
  freeText,
  onFreeTextChange,
  onSubmitAnswer,
  onSendFreeText,
}: {
  mcq: NonNullable<StudentCoachSessionView["activeMcq"]>;
  submitting: boolean;
  selectedToken: string;
  onSelectToken: (token: string) => void;
  showFreeText: boolean;
  onToggleFreeText: () => void;
  freeText: string;
  onFreeTextChange: (value: string) => void;
  onSubmitAnswer: () => void;
  onSendFreeText: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-card p-4">
      <p className="text-sm font-medium">
        <MathText text={mcq.text} />
      </p>
      <div role="radiogroup" aria-label="Answer choices" className="space-y-2">
        {mcq.options.map((opt) => {
          const active = selectedToken === opt.optionToken;
          return (
            <button
              key={opt.optionToken}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={submitting}
              onClick={() => onSelectToken(opt.optionToken)}
              className={`flex w-full items-start gap-2.5 rounded-lg border p-3 text-left text-sm transition-colors ${
                active
                  ? "border-primary bg-primary/10 font-medium"
                  : "border-border hover:border-primary/40 hover:bg-muted/50"
              }`}
            >
              <span
                className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40 text-muted-foreground"
                }`}
              >
                {opt.label}
              </span>
              <span>
                <MathText text={opt.text} />
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          onClick={onToggleFreeText}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          {showFreeText ? "Hide message box" : "Need to say something?"}
        </button>
        <Button
          size="sm"
          disabled={!selectedToken || submitting}
          onClick={onSubmitAnswer}
        >
          {submitting ? (
            <>
              <Loader2 className="size-3.5 animate-spin" /> Submitting…
            </>
          ) : (
            "Submit answer"
          )}
        </Button>
      </div>

      {showFreeText && (
        <div className="space-y-2 border-t pt-2">
          <Textarea
            aria-label="Message to coach"
            rows={2}
            maxLength={COACH_MAX_EXPLANATION_CHARS}
            value={freeText}
            onChange={(e) => onFreeTextChange(e.target.value)}
            placeholder="Type a message or let us know if you need help…"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!freeText.trim() || submitting}
            onClick={onSendFreeText}
          >
            <Send className="size-3.5" /> Send message
          </Button>
        </div>
      )}
    </div>
  );
}

function CoachSessionFooter({
  session,
  variant,
  submitting,
  explanationText,
  onExplanationChange,
  onSubmitExplanation,
  confirmEnd,
  onConfirmEndChange,
  onEndChat,
}: {
  session: StudentCoachSessionView;
  variant: "inline" | "drawer";
  submitting: boolean;
  explanationText: string;
  onExplanationChange: (value: string) => void;
  onSubmitExplanation: () => void;
  confirmEnd: boolean;
  onConfirmEndChange: (value: boolean) => void;
  onEndChat: () => void;
}) {
  const canEndChat =
    session.state !== "COMPLETED" &&
    session.state !== "INCOMPLETE" &&
    session.state !== "GENERATING_TUTORING";

  if (session.state !== "AWAITING_EXPLANATION" && !canEndChat) return null;

  return (
    <div className="shrink-0 space-y-2.5 border-t bg-background px-5 py-3.5">
      {session.state === "AWAITING_EXPLANATION" && (
        <div className="space-y-2">
          <Textarea
            rows={3}
            maxLength={COACH_MAX_EXPLANATION_CHARS}
            value={explanationText}
            onChange={(e) => onExplanationChange(e.target.value)}
            disabled={submitting}
            placeholder="Explain your thinking in one or two sentences…"
            aria-label="Your explanation"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {explanationText.length} / {COACH_MAX_EXPLANATION_CHARS}
            </span>
            <Button
              size="sm"
              disabled={submitting}
              onClick={onSubmitExplanation}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Reviewing…
                </>
              ) : (
                <>
                  <Send className="size-3.5" /> Submit explanation
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {canEndChat && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {confirmEnd ? (
            <div className="flex w-full items-center justify-between gap-2">
              <span>End this chat early? Progress will be saved.</span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={submitting}
                  onClick={() => onConfirmEndChange(false)}
                >
                  Keep going
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={submitting}
                  onClick={onEndChat}
                >
                  End chat
                </Button>
              </div>
            </div>
          ) : (
            <>
              <span>
                {variant === "drawer"
                  ? "Closing this drawer saves your progress."
                  : "Your progress is saved automatically."}
              </span>
              <button
                type="button"
                onClick={() => onConfirmEndChange(true)}
                className="underline hover:text-foreground"
              >
                End chat early
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Structured Diagnose -> Route -> Remediate -> Review Wrong Answer Coach panel.
 * Embeds inline in Step 2 (`CoachStep`) or inside `WrongAnswerCoachDrawer`.
 */
export function WrongAnswerCoachPanel({
  attemptId,
  questionId,
  questionNumber,
  variant = "inline",
  onStateChange,
  onEngaged,
  onSessionLoaded,
}: WrongAnswerCoachPanelProps) {
  const [session, setSession] = useState<StudentCoachSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [explanationText, setExplanationText] = useState("");
  const [selectedToken, setSelectedToken] = useState("");
  const [showFreeText, setShowFreeText] = useState(false);
  const [freeText, setFreeText] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const onStateChangeRef = useRef(onStateChange);
  const onEngagedRef = useRef(onEngaged);
  const onSessionLoadedRef = useRef(onSessionLoaded);

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
    onEngagedRef.current = onEngaged;
    onSessionLoadedRef.current = onSessionLoaded;
  }, [onStateChange, onEngaged, onSessionLoaded]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setSelectedToken("");
    setShowFreeText(false);
    setConfirmEnd(false);

    void (async () => {
      try {
        const res = await fetch(
          `/api/student/attempts/${attemptId}/coach/sessions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionId }),
          },
        );
        const data = await res.json();
        if (!active) return;
        if (!res.ok) {
          setError(data.error || "Could not open chat.");
          setSession(null);
          onSessionLoadedRef.current?.(null);
        } else {
          const loaded = data as StudentCoachSessionView;
          setSession(loaded);
          onSessionLoadedRef.current?.(loaded);
          if (isSessionEngaged(loaded)) {
            onEngagedRef.current?.(true);
          }
          onStateChangeRef.current?.();
        }
      } catch {
        if (active) setError("Could not reach the server. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [attemptId, questionId]);

  const sessionId = session?.sessionId;
  const sessionState = session?.state;

  // Poll cleanly if resumed while tutoring is still generating.
  useEffect(() => {
    if (!sessionId || sessionState !== "GENERATING_TUTORING") return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/student/coach/sessions/${sessionId}`);
        if (!res.ok) return;
        const data = (await res.json()) as StudentCoachSessionView;
        setSession(data);
        onSessionLoadedRef.current?.(data);
        if (data.state !== "GENERATING_TUTORING") {
          onEngagedRef.current?.(true);
          onStateChangeRef.current?.();
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [sessionId, sessionState]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages.length, session?.state]);

  async function sendTurn(payload: Record<string, unknown>) {
    if (!session || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/student/coach/sessions/${session.sessionId}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        // Refresh session state on 503/409 so CLASSIFYING_FAILED retry UI appears.
        const refreshRes = await fetch(
          `/api/student/coach/sessions/${session.sessionId}`,
        );
        if (refreshRes.ok) {
          const refreshed =
            (await refreshRes.json()) as StudentCoachSessionView;
          setSession(refreshed);
          onSessionLoadedRef.current?.(refreshed);
        }
      } else {
        const updated = data as StudentCoachSessionView;
        setSession(updated);
        onSessionLoadedRef.current?.(updated);
        setExplanationText("");
        setSelectedToken("");
        setFreeText("");
        setShowFreeText(false);
        setConfirmEnd(false);
        if (isSessionEngaged(updated)) {
          onEngagedRef.current?.(true);
        }
        onStateChangeRef.current?.();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {variant === "inline" && (
        <div className="shrink-0 space-y-2 border-b px-5 py-3.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <MessageSquare className="size-4 text-primary" />
              Question {questionNumber} — Wrong Answer Coach
            </h3>
            {session && <StatusBadge state={session.state} />}
          </div>
          <p className="text-xs text-muted-foreground">
            Answer each short step so we can pinpoint what happened and walk
            through the solution.
          </p>
          {session && <StepPills state={session.state} />}
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading review chat…
          </div>
        ) : !session ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error || "Unable to load chat."}
          </div>
        ) : (
          <>
            <OriginalQuestionCard session={session} />

            <div className="space-y-3">
              {session.messages.map((msg) => {
                const isStudent = msg.role === "student";
                return (
                  <div
                    key={msg.seq}
                    className={`flex ${isStudent ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[90%] rounded-xl px-3.5 py-2.5 text-sm ${
                        isStudent
                          ? "bg-primary text-primary-foreground"
                          : "border bg-card text-card-foreground"
                      }`}
                    >
                      {msg.structuredTutoring ? (
                        <TutoringMessageCard
                          structured={msg.structuredTutoring}
                        />
                      ) : (
                        <p className="whitespace-pre-wrap">
                          {msg.content ? (
                            <MathText text={msg.content} />
                          ) : (
                            <span className="italic opacity-75">
                              (No explanation entered)
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {session.activeMcq && (
              <ActiveMcqCard
                mcq={session.activeMcq}
                submitting={submitting}
                selectedToken={selectedToken}
                onSelectToken={setSelectedToken}
                showFreeText={showFreeText}
                onToggleFreeText={() => setShowFreeText((v) => !v)}
                freeText={freeText}
                onFreeTextChange={setFreeText}
                onSubmitAnswer={() =>
                  void sendTurn({
                    type: session.activeMcq!.step,
                    optionToken: selectedToken,
                  })
                }
                onSendFreeText={() =>
                  void sendTurn({ type: "free_text", text: freeText })
                }
              />
            )}

            {session.state === "CLASSIFYING_FAILED" && (
              <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/70 p-3.5 dark:border-amber-800 dark:bg-amber-950/30">
                <p className="text-sm">
                  We couldn&apos;t finish analyzing your explanation because of
                  a temporary service issue. Your explanation is saved.
                </p>
                <Button
                  size="sm"
                  disabled={submitting}
                  onClick={() =>
                    void sendTurn({ type: "retry_classification" })
                  }
                >
                  {submitting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )}
                  Try again
                </Button>
              </div>
            )}

            {session.state === "GENERATING_TUTORING" && (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3.5 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Preparing your
                personalized explanation…
              </div>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            )}

            <div ref={bottomRef} />
          </>
        )}
      </div>

      {session && (
        <CoachSessionFooter
          session={session}
          variant={variant}
          submitting={submitting}
          explanationText={explanationText}
          onExplanationChange={setExplanationText}
          onSubmitExplanation={() =>
            void sendTurn({ type: "explanation", text: explanationText })
          }
          confirmEnd={confirmEnd}
          onConfirmEndChange={setConfirmEnd}
          onEndChat={() => void sendTurn({ type: "leave" })}
        />
      )}
    </div>
  );
}

export function WrongAnswerCoachDrawer({
  open,
  onOpenChange,
  attemptId,
  questionId,
  questionNumber,
  onStateChange,
}: WrongAnswerCoachDrawerProps) {
  const [session, setSession] = useState<StudentCoachSessionView | null>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col overflow-hidden p-0 sm:max-w-xl"
      >
        <SheetHeader className="shrink-0 space-y-2 border-b px-5 py-4">
          <div className="flex items-center justify-between gap-2 pr-6">
            <SheetTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="size-4 text-primary" />
              Question {questionNumber} — Review Chat
            </SheetTitle>
            {session && <StatusBadge state={session.state} />}
          </div>
          <SheetDescription className="text-xs">
            Answer each short step so we can pinpoint what happened and walk
            through the solution.
          </SheetDescription>
          {session && <StepPills state={session.state} />}
        </SheetHeader>

        {open && (
          <WrongAnswerCoachPanel
            attemptId={attemptId}
            questionId={questionId}
            questionNumber={questionNumber}
            variant="drawer"
            onStateChange={onStateChange}
            onSessionLoaded={setSession}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
