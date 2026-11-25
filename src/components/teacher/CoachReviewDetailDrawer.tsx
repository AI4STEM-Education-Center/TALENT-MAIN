"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MathText } from "@/components/ui/math-text";
import { cn } from "@/lib/utils";
import type { ReviewOptionView } from "@/lib/wrong-answer-coach-review";
import type {
  Check2RunSlot,
  CoachFlagCode,
  TutoringAttemptRecord,
} from "@/lib/wrong-answer-coach-types";

export interface CoachReviewDetail {
  id: string;
  classId: string;
  className: string;
  quizId: string;
  quizName: string;
  questionNumber: number;
  studentName: string;
  originalQuestionText: string;
  originalOptions?: ReviewOptionView[];
  correctOptionText: string;
  chosenOptionText: string;
  state: string;
  endedReason: string | null;
  startedAt: string;
  completedAt: string | null;
  check1Label: string | null;
  explanationText: string | null;
  check2Runs: Check2RunSlot[];
  check2ShortCircuitReason: string | null;
  check2ResultKind: string | null;
  check2MisconceptionCode: string | null;
  check2TopVoteCount: number | null;
  check2VoteHistogram: Record<string, number>;
  check2MeanConfidence: number | null;
  check2WasTie: boolean;
  secondQuestionText: string;
  secondQuestionOptions?: ReviewOptionView[];
  check3SelectedText: string | null;
  check3IsCorrect: boolean | null;
  check3Label: string | null;
  diagnosis: string | null;
  diagnosisMisconceptionCode: string | null;
  decisionTableRow: number | null;
  diagnosisReason: string | null;
  heldOutQuestionText: string;
  heldOutQuestionOptions?: ReviewOptionView[];
  heldOutSelectedText: string | null;
  heldOutIsCorrect: boolean | null;
  heldOutLabel: string | null;
  tutoringMessage: string | null;
  tutoringAttempts: TutoringAttemptRecord[];
  tutoringUsedFallback: boolean;
  classifierModel: string | null;
  classifierProvider: string | null;
  classifierApiSurface: string | null;
  classifierPromptVersion: string | null;
  tutorModel: string | null;
  tutorProvider: string | null;
  tutorPromptVersion: string | null;
  flags: CoachFlagCode[];
  messages: Array<{
    seq: number;
    role: string;
    kind: string;
    content: string;
    createdAt: string;
  }>;
}

function ReviewOptionsList({ options }: { options: ReviewOptionView[] }) {
  if (options.length === 0) return null;
  return (
    <ul className="space-y-1.5 pt-1">
      {options.map((opt) => {
        const isRight = opt.isCorrect;
        const isWrongPick = opt.isChosen && !opt.isCorrect;
        return (
          <li
            key={opt.label}
            className={cn(
              "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs",
              isRight &&
                "border-emerald-500/40 bg-emerald-50/70 dark:bg-emerald-950/30",
              isWrongPick && "border-destructive/40 bg-destructive/5",
              !isRight && !isWrongPick && "border-border bg-card",
            )}
          >
            <span
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded border text-[11px] font-semibold",
                isRight && "border-emerald-700 bg-emerald-700 text-white",
                isWrongPick &&
                  "border-destructive bg-destructive text-destructive-foreground",
                !isRight &&
                  !isWrongPick &&
                  "border-border bg-muted text-muted-foreground",
              )}
            >
              {opt.label}
            </span>
            <span className="min-w-0 flex-1 pt-0.5 text-foreground">
              <MathText text={opt.text} />
            </span>
            <span className="flex shrink-0 flex-wrap items-center gap-1">
              {opt.isChosen && (
                <Badge
                  variant={opt.isCorrect ? "success" : "destructive"}
                  className="text-[10px]"
                >
                  {opt.isCorrect ? "Chosen · Correct" : "Student chose"}
                </Badge>
              )}
              {!opt.isChosen && opt.isCorrect && (
                <Badge variant="success" className="text-[10px]">
                  Correct
                </Badge>
              )}
              {opt.misconceptionCode && (
                <Badge variant="outline" className="text-[10px]">
                  {opt.misconceptionCode}
                </Badge>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function VariantCheckBlock({
  title,
  questionText,
  options,
  selectedText,
  isCorrect,
  label,
}: {
  title: string;
  questionText: string;
  options: ReviewOptionView[];
  selectedText: string | null;
  isCorrect: boolean | null;
  label: string | null;
}) {
  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-foreground">{title}</span>
        {selectedText ? (
          <Badge
            variant={isCorrect ? "success" : "destructive"}
            className="gap-1"
          >
            {isCorrect ? (
              <CheckCircle2 className="size-3" />
            ) : (
              <XCircle className="size-3" />
            )}
            {isCorrect ? "Correct" : `Incorrect${label ? ` (${label})` : ""}`}
          </Badge>
        ) : (
          <Badge variant="secondary">Not answered</Badge>
        )}
      </div>
      <p className="text-foreground">
        <MathText text={questionText} />
      </p>
      <ReviewOptionsList options={options} />
    </div>
  );
}

function Check2Section({ detail }: { detail: CoachReviewDetail }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Check 2 — Explanation Classification (
          {detail.classifierApiSurface ?? "decisions"})
        </h3>
        {detail.classifierModel && (
          <span className="font-mono text-xs text-muted-foreground">
            {detail.classifierProvider}/{detail.classifierModel}
          </span>
        )}
      </div>

      <div className="rounded bg-muted/50 p-2.5 text-xs">
        <span className="font-medium text-muted-foreground">
          Student explanation:{" "}
        </span>
        {detail.explanationText ? (
          <span className="whitespace-pre-wrap text-foreground">
            <MathText text={detail.explanationText} />
          </span>
        ) : (
          <em className="text-muted-foreground">Not submitted yet</em>
        )}
      </div>

      {detail.check2ShortCircuitReason && (
        <p className="text-xs text-muted-foreground">
          Short-circuit reason:{" "}
          <code className="font-mono">{detail.check2ShortCircuitReason}</code>
        </p>
      )}

      {detail.check2ResultKind && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Aggregate result:</span>
          <Badge variant="outline">
            {detail.check2ResultKind}
            {detail.check2MisconceptionCode
              ? ` (${detail.check2MisconceptionCode})`
              : ""}
          </Badge>
          {detail.check2TopVoteCount !== null && (
            <span className="text-muted-foreground">
              Votes: {detail.check2TopVoteCount}/5
            </span>
          )}
          {detail.check2MeanConfidence !== null && (
            <span className="text-muted-foreground">
              Mean confidence: {(detail.check2MeanConfidence * 100).toFixed(0)}%
            </span>
          )}
          {detail.check2WasTie && (
            <Badge variant="secondary">Tie → Neither</Badge>
          )}
        </div>
      )}

      {detail.check2Runs.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            5 Independent Decisions API Runs
          </p>
          <div className="space-y-1.5">
            {detail.check2Runs.map((run) => (
              <div
                key={run.runIndex}
                className="space-y-1 rounded border bg-background px-2.5 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    Run #{run.runIndex + 1}:{" "}
                    <code className="font-mono">
                      {run.choice ?? run.parsedKind}
                    </code>
                    {run.retried && " (retried)"}
                  </span>
                  <span className="text-muted-foreground">
                    {run.confidence !== null
                      ? `${(run.confidence * 100).toFixed(0)}% conf`
                      : "n/a"}{" "}
                    • {run.latencyMs}ms
                  </span>
                </div>
                {run.probabilities.length > 0 && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    {run.probabilities.slice(0, 4).map((p) => (
                      <span key={p.value}>
                        {p.value}: {(p.probability * 100).toFixed(0)}%
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function DiagnosticChecksSection({ detail }: { detail: CoachReviewDetail }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-3.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Check 3, Decision Table Diagnosis &amp; Held-Out Check
      </h3>

      <VariantCheckBlock
        title="Check 3 (Similar question)"
        questionText={detail.secondQuestionText}
        options={detail.secondQuestionOptions ?? []}
        selectedText={detail.check3SelectedText}
        isCorrect={detail.check3IsCorrect}
        label={detail.check3Label}
      />

      <div className="space-y-1 rounded bg-muted/50 p-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-foreground">
            System Diagnosis:
          </span>
          {detail.diagnosis ? (
            <Badge>
              {detail.diagnosis}
              {detail.diagnosisMisconceptionCode
                ? ` (${detail.diagnosisMisconceptionCode})`
                : ""}
            </Badge>
          ) : (
            <Badge variant="secondary">None (incomplete)</Badge>
          )}
          {detail.decisionTableRow !== null && (
            <span className="text-muted-foreground">
              Table 3 Row #{detail.decisionTableRow}
            </span>
          )}
        </div>
        {detail.diagnosisReason && (
          <p className="text-muted-foreground">{detail.diagnosisReason}</p>
        )}
      </div>

      <VariantCheckBlock
        title="Held-out question"
        questionText={detail.heldOutQuestionText}
        options={detail.heldOutQuestionOptions ?? []}
        selectedText={detail.heldOutSelectedText}
        isCorrect={detail.heldOutIsCorrect}
        label={detail.heldOutLabel}
      />
    </section>
  );
}

export function CoachReviewDetailDrawer({
  sessionId,
  apiBasePath,
  onClose,
}: {
  sessionId: string | null;
  apiBasePath: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<CoachReviewDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${apiBasePath}/${sessionId}`)
      .then(async (res) => {
        const data = (await res.json()) as {
          session?: CoachReviewDetail;
          error?: string;
        };
        if (!res.ok || !data.session) {
          throw new Error(data.error || "Failed to load session detail.");
        }
        if (!cancelled) setDetail(data.session);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load session.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, apiBasePath]);

  return (
    <Sheet open={Boolean(sessionId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full space-y-5 overflow-y-auto p-6 sm:max-w-2xl"
      >
        <SheetHeader className="p-0 pr-8">
          <SheetTitle className="text-foreground">
            {detail
              ? `${detail.studentName} — ${detail.quizName} (Q${detail.questionNumber})`
              : "Wrong Answer Coach Session"}
          </SheetTitle>
          <SheetDescription className="text-muted-foreground">
            {detail
              ? `${detail.className} • State: ${detail.state}${detail.endedReason ? ` (${detail.endedReason})` : ""}`
              : "Loading diagnostic record…"}
          </SheetDescription>
        </SheetHeader>

        {loading && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading full diagnostic record…
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {detail && !loading && (
          <div className="space-y-5 text-sm text-foreground">
            {detail.flags.includes("PERSONAL_SUPPORT_NEEDED") && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-semibold">
                    Personal Support Safety Flag Recorded
                  </p>
                  <p className="mt-0.5 text-xs">
                    The student&apos;s message triggered the personal-support /
                    safety redirect.
                  </p>
                </div>
              </div>
            )}

            {detail.flags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {detail.flags.map((flag) => (
                  <Badge
                    key={flag}
                    variant={
                      flag === "PERSONAL_SUPPORT_NEEDED"
                        ? "destructive"
                        : "secondary"
                    }
                  >
                    {flag}
                  </Badge>
                ))}
              </div>
            )}

            {/* Original Question + Check 1 */}
            <section className="space-y-2 rounded-lg border bg-card p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Original Question &amp; Check 1
                </h3>
                <Badge variant="outline" className="text-[11px]">
                  Check 1: {detail.check1Label ?? "None (unlabeled distractor)"}
                </Badge>
              </div>
              <p className="font-medium text-foreground">
                <MathText text={detail.originalQuestionText} />
              </p>
              {detail.originalOptions && detail.originalOptions.length > 0 ? (
                <ReviewOptionsList options={detail.originalOptions} />
              ) : (
                <div className="grid gap-1.5 text-xs">
                  <div>
                    <span className="text-muted-foreground">
                      Student chose:{" "}
                    </span>
                    <span className="font-medium text-destructive">
                      <MathText text={detail.chosenOptionText} />
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      Correct option:{" "}
                    </span>
                    <span className="font-medium text-emerald-700 dark:text-emerald-400">
                      <MathText text={detail.correctOptionText} />
                    </span>
                  </div>
                </div>
              )}
            </section>

            <Check2Section detail={detail} />
            <DiagnosticChecksSection detail={detail} />

            {/* Tutoring Output */}
            {detail.tutoringMessage && (
              <section className="space-y-2 rounded-lg border bg-card p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Step 10 Tutoring Output
                  </h3>
                  <div className="flex items-center gap-2">
                    {detail.tutoringUsedFallback && (
                      <Badge variant="secondary">
                        Used Deterministic Fallback
                      </Badge>
                    )}
                    {detail.tutorModel && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {detail.tutorProvider}/{detail.tutorModel}
                      </span>
                    )}
                  </div>
                </div>
                <p className="whitespace-pre-wrap rounded bg-muted/40 p-2.5 text-xs text-foreground">
                  <MathText text={detail.tutoringMessage} />
                </p>
                {detail.tutoringAttempts.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      Tutoring generation audit (
                      {detail.tutoringAttempts.length} attempt
                      {detail.tutoringAttempts.length === 1 ? "" : "s"})
                    </summary>
                    <div className="mt-2 space-y-1.5">
                      {detail.tutoringAttempts.map((a) => (
                        <div
                          key={a.attempt}
                          className="space-y-0.5 rounded border p-2 text-[11px]"
                        >
                          <div className="font-medium">
                            Attempt #{a.attempt}:{" "}
                            {a.valid ? "Valid" : "Rejected"} ({a.latencyMs}ms)
                          </div>
                          {a.failureReasons.length > 0 && (
                            <div className="text-destructive">
                              Reasons: {a.failureReasons.join(", ")}
                            </div>
                          )}
                          {a.providerError && (
                            <div className="text-destructive">
                              Provider error: {a.providerError}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </section>
            )}

            {/* Full Transcript */}
            <section className="space-y-2 rounded-lg border bg-card p-3.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Full Transcript ({detail.messages.length} turns)
              </h3>
              <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {detail.messages.map((m) => (
                  <div
                    key={m.seq}
                    className="space-y-0.5 rounded bg-muted/40 px-2.5 py-1.5 text-xs"
                  >
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span className="font-medium uppercase">
                        {m.role} • {m.kind}
                      </span>
                      <span>
                        {new Date(m.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-foreground">
                      <MathText text={m.content} />
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <div className="flex justify-end">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
