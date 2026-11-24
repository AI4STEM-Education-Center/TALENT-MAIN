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
        {structured.bodyParagraphs.map((para, i) => (
          <p key={`${i}-${para.slice(0, 16)}`}>
            <MathText text={para} />
          </p>
        ))}
      </div>
      {structured.keyPoints && structured.keyPoints.length > 0 && (
        <ul className="list-disc pl-5 space-y-1 text-sm">
          {structured.keyPoints.map((kp, i) => (
            <li key={`${i}-${kp.slice(0, 16)}`}>
              <MathText text={kp} />
            </li>
          ))}
        </ul>
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
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [explanationText, setExplanationText] = useState("");
  const [selectedToken, setSelectedToken] = useState<string>("");
  const [showFreeText, setShowFreeText] = useState(false);
  const [freeText, setFreeText] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
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
        } else {
          setSession(data as StudentCoachSessionView);
          onStateChange?.();
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
  }, [open, attemptId, questionId, onStateChange]);

  // Poll cleanly if resumed while tutoring is still generating.
  useEffect(() => {
    if (!open || !session || session.state !== "GENERATING_TUTORING") return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/student/coach/sessions/${session.sessionId}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as StudentCoachSessionView;
        setSession(data);
        if (data.state !== "GENERATING_TUTORING") onStateChange?.();
      } catch {
        // ignore transient poll errors
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [open, session, onStateChange]);

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
          setSession((await refreshRes.json()) as StudentCoachSessionView);
        }
      } else {
        setSession(data as StudentCoachSessionView);
        setExplanationText("");
        setSelectedToken("");
        setFreeText("");
        setShowFreeText(false);
        setConfirmEnd(false);
        onStateChange?.();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const activeStep = session ? currentStepIndex(session.state) : 0;
  const canEndChat =
    session &&
    session.state !== "COMPLETED" &&
    session.state !== "INCOMPLETE" &&
    session.state !== "GENERATING_TUTORING";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl flex flex-col p-0 overflow-hidden"
      >
        <SheetHeader className="px-5 py-4 border-b shrink-0 space-y-2">
          <div className="flex items-center justify-between gap-2 pr-6">
            <SheetTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="size-4 text-primary" />
              Question {questionNumber} — Review Chat
            </SheetTitle>
            {session?.state === "COMPLETED" && (
              <Badge variant="success">Completed</Badge>
            )}
            {session?.state === "INCOMPLETE" && (
              <Badge variant="secondary">Ended early</Badge>
            )}
          </div>
          <SheetDescription className="text-xs">
            Answer each short step so we can pinpoint what happened and walk
            through the solution.
          </SheetDescription>
          {session && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {STEP_LABELS.map((label, idx) => (
                <span
                  key={label}
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium border ${
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
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground gap-2">
              <Loader2 className="size-4 animate-spin" /> Loading review chat…
            </div>
          ) : !session ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {error || "Unable to load chat."}
            </div>
          ) : (
            <>
              {/* Pinned original missed question context (NO answer key before COMPLETED) */}
              <div className="rounded-lg border bg-muted/40 p-3.5 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Original question
                </p>
                <p className="text-sm font-medium">
                  <MathText text={session.originalQuestion.text} />
                </p>
                <div className="flex items-start gap-2 rounded bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                  <XCircle className="size-3.5 mt-0.5 shrink-0" />
                  <span>
                    <strong>Your answer:</strong>{" "}
                    <MathText
                      text={session.originalQuestion.chosenOptionText}
                    />
                  </span>
                </div>
                {session.state === "COMPLETED" &&
                  session.originalQuestion.correctOptionText && (
                    <div className="flex items-start gap-2 rounded bg-green-50 px-2.5 py-1.5 text-xs text-green-700 dark:bg-green-950/30 dark:text-green-400">
                      <CheckCircle2 className="size-3.5 mt-0.5 shrink-0" />
                      <span>
                        <strong>Correct answer:</strong>{" "}
                        <MathText
                          text={session.originalQuestion.correctOptionText}
                        />
                      </span>
                    </div>
                  )}
              </div>

              {/* Conversation transcript */}
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

              {/* Active MCQ card (Steps 6–7 or Steps 9–10) */}
              {session.activeMcq && (
                <div className="rounded-lg border border-primary/30 bg-card p-4 space-y-3">
                  <p className="text-sm font-medium">
                    <MathText text={session.activeMcq.text} />
                  </p>
                  <div
                    role="radiogroup"
                    aria-label="Answer choices"
                    className="space-y-2"
                  >
                    {session.activeMcq.options.map((opt) => {
                      const active = selectedToken === opt.optionToken;
                      return (
                        <button
                          key={opt.optionToken}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={submitting}
                          onClick={() => setSelectedToken(opt.optionToken)}
                          className={`w-full text-left rounded-lg border p-3 text-sm transition-colors flex items-start gap-2.5 ${
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
                      onClick={() => setShowFreeText((v) => !v)}
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                    >
                      {showFreeText
                        ? "Hide message box"
                        : "Need to say something?"}
                    </button>
                    <Button
                      size="sm"
                      disabled={!selectedToken || submitting}
                      onClick={() =>
                        void sendTurn({
                          type: session.activeMcq!.step,
                          optionToken: selectedToken,
                        })
                      }
                    >
                      {submitting ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />{" "}
                          Submitting…
                        </>
                      ) : (
                        "Submit answer"
                      )}
                    </Button>
                  </div>

                  {showFreeText && (
                    <div className="pt-2 border-t space-y-2">
                      <Textarea
                        aria-label="Message to coach"
                        rows={2}
                        maxLength={COACH_MAX_EXPLANATION_CHARS}
                        value={freeText}
                        onChange={(e) => setFreeText(e.target.value)}
                        placeholder="Type a message or let us know if you need help…"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!freeText.trim() || submitting}
                        onClick={() =>
                          void sendTurn({ type: "free_text", text: freeText })
                        }
                      >
                        <Send className="size-3.5" /> Send message
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {session.state === "CLASSIFYING_FAILED" && (
                <div className="rounded-lg border border-amber-300 bg-amber-50/70 p-3.5 space-y-2 dark:border-amber-800 dark:bg-amber-950/30">
                  <p className="text-sm">
                    We couldn&apos;t finish analyzing your explanation because
                    of a temporary service issue. Your explanation is saved.
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

        {/* Bottom input area for Step 4 + explicit End Chat control */}
        {session && (
          <div className="border-t px-5 py-3.5 bg-background shrink-0 space-y-2.5">
            {session.state === "AWAITING_EXPLANATION" && (
              <div className="space-y-2">
                <Textarea
                  rows={3}
                  maxLength={COACH_MAX_EXPLANATION_CHARS}
                  value={explanationText}
                  onChange={(e) => setExplanationText(e.target.value)}
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
                    onClick={() =>
                      void sendTurn({
                        type: "explanation",
                        text: explanationText,
                      })
                    }
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
                  <div className="flex items-center gap-2 w-full justify-between">
                    <span>End this chat early? Progress will be saved.</span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={submitting}
                        onClick={() => setConfirmEnd(false)}
                      >
                        Keep going
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={submitting}
                        onClick={() => void sendTurn({ type: "leave" })}
                      >
                        End chat
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span>Closing this drawer saves your progress.</span>
                    <button
                      type="button"
                      onClick={() => setConfirmEnd(true)}
                      className="underline hover:text-foreground"
                    >
                      End chat early
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
