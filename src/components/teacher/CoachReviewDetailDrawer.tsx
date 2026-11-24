"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MathText } from "@/components/ui/math-text";
import type {
  Check2RunSlot,
  CoachFlagCode,
  CoachReviewDecision,
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
  check3SelectedText: string | null;
  check3IsCorrect: boolean | null;
  check3Label: string | null;
  diagnosis: string | null;
  diagnosisMisconceptionCode: string | null;
  decisionTableRow: number | null;
  diagnosisReason: string | null;
  heldOutQuestionText: string;
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
  reviewStatus: string;
  reviewDecision: string | null;
  reviewOverrideCode: string | null;
  reviewNotes: string | null;
  reviewedAt: string | null;
  messages: Array<{
    seq: number;
    role: string;
    kind: string;
    content: string;
    createdAt: string;
  }>;
}

export interface MisconceptionCatalogItem {
  misconceptionId: string;
  statement: string;
}

const ALL_DECISION_OPTIONS: Array<{
  value: CoachReviewDecision;
  label: string;
  requiresDiagnosis: boolean;
}> = [
  {
    value: "AGREE_DIAGNOSIS",
    label: "Agree with system diagnosis",
    requiresDiagnosis: true,
  },
  {
    value: "OVERRIDE_SLIP",
    label: "Override → Slip",
    requiresDiagnosis: true,
  },
  {
    value: "OVERRIDE_KNOWLEDGE_GAP",
    label: "Override → Knowledge Gap",
    requiresDiagnosis: true,
  },
  {
    value: "OVERRIDE_MISCONCEPTION",
    label: "Override → Misconception",
    requiresDiagnosis: true,
  },
  {
    value: "ESCALATED_FOLLOWUP",
    label: "Escalated for instructor follow-up",
    requiresDiagnosis: false,
  },
  {
    value: "DISMISSED",
    label: "Dismiss flag / no action needed",
    requiresDiagnosis: false,
  },
];

export function CoachReviewDetailDrawer({
  sessionId,
  apiBasePath,
  catalog,
  onClose,
  onSaved,
}: {
  sessionId: string | null;
  apiBasePath: string;
  catalog: MisconceptionCatalogItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<CoachReviewDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const [decision, setDecision] =
    useState<CoachReviewDecision>("AGREE_DIAGNOSIS");
  const [overrideCode, setOverrideCode] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSavedMsg(null);

    fetch(`${apiBasePath}/${sessionId}`)
      .then(async (res) => {
        const data = (await res.json()) as {
          session?: CoachReviewDetail;
          error?: string;
        };
        if (!res.ok || !data.session) {
          throw new Error(data.error || "Failed to load session detail.");
        }
        if (cancelled) return;
        const s = data.session;
        setDetail(s);
        const defaultDec: CoachReviewDecision =
          (s.reviewDecision as CoachReviewDecision | null) ??
          (s.diagnosis ? "AGREE_DIAGNOSIS" : "ESCALATED_FOLLOWUP");
        setDecision(defaultDec);
        setOverrideCode(
          s.reviewOverrideCode || catalog[0]?.misconceptionId || "",
        );
        setNotes(s.reviewNotes || "");
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
  }, [sessionId, apiBasePath, catalog]);

  async function handleSave() {
    if (!detail || saving) return;
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const res = await fetch(`${apiBasePath}/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewDecision: decision,
          reviewOverrideCode:
            decision === "OVERRIDE_MISCONCEPTION" ? overrideCode : null,
          reviewNotes: notes.trim() || null,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        session?: CoachReviewDetail;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Could not save review decision.");
      }
      if (data.session) setDetail(data.session);
      setSavedMsg("Review decision saved.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const hasDiagnosis =
    detail?.diagnosis !== null && detail?.diagnosis !== undefined;
  const availableDecisions = ALL_DECISION_OPTIONS.filter(
    (opt) => !opt.requiresDiagnosis || hasDiagnosis,
  );

  return (
    <Sheet open={Boolean(sessionId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-y-auto p-6 space-y-5"
      >
        <SheetHeader className="p-0">
          <SheetTitle>
            {detail
              ? `${detail.studentName} — ${detail.quizName} (Q${detail.questionNumber})`
              : "Wrong Answer Coach Session"}
          </SheetTitle>
          <SheetDescription>
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
          <div className="space-y-5 text-sm">
            {detail.flags.includes("PERSONAL_SUPPORT_NEEDED") && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-semibold">
                    Urgent: Personal Support Flagged
                  </p>
                  <p className="text-xs mt-0.5">
                    The student&apos;s message triggered the personal-support /
                    safety redirect. Follow up according to institutional
                    support procedures.
                  </p>
                </div>
              </div>
            )}

            {/* Flags */}
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
            <section className="rounded-lg border p-3.5 space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Original Question &amp; Check 1
              </h3>
              <p className="font-medium">
                <MathText text={detail.originalQuestionText} />
              </p>
              <div className="grid gap-1.5 text-xs">
                <div>
                  <span className="text-muted-foreground">Student chose: </span>
                  <span className="text-destructive font-medium">
                    <MathText text={detail.chosenOptionText} />
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">
                    Correct option:{" "}
                  </span>
                  <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                    <MathText text={detail.correctOptionText} />
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Check 1 label: </span>
                  <Badge variant="outline">
                    {detail.check1Label ?? "None (unlabeled distractor)"}
                  </Badge>
                </div>
              </div>
            </section>

            {/* Check 2: Explanation + 5 Decisions API Runs */}
            <section className="rounded-lg border p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Check 2 — Explanation Classification (
                  {detail.classifierApiSurface ?? "decisions"})
                </h3>
                {detail.classifierModel && (
                  <span className="text-xs font-mono text-muted-foreground">
                    {detail.classifierProvider}/{detail.classifierModel}
                  </span>
                )}
              </div>

              <div className="rounded bg-muted/50 p-2.5 text-xs">
                <span className="font-medium text-muted-foreground">
                  Student explanation:{" "}
                </span>
                {detail.explanationText ? (
                  <span className="whitespace-pre-wrap">
                    <MathText text={detail.explanationText} />
                  </span>
                ) : (
                  <em className="text-muted-foreground">Not submitted yet</em>
                )}
              </div>

              {detail.check2ShortCircuitReason && (
                <p className="text-xs text-muted-foreground">
                  Short-circuit reason:{" "}
                  <code className="font-mono">
                    {detail.check2ShortCircuitReason}
                  </code>
                </p>
              )}

              {detail.check2ResultKind && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span>Aggregate result:</span>
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
                      Mean confidence:{" "}
                      {(detail.check2MeanConfidence * 100).toFixed(0)}%
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
                        className="rounded border bg-background px-2.5 py-2 text-xs space-y-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">
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

            {/* Check 3 + Deterministic Diagnosis + Held-Out */}
            <section className="rounded-lg border p-3.5 space-y-2.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Check 3, Decision Table Diagnosis &amp; Held-Out Check
              </h3>

              <div className="space-y-1 text-xs">
                <p>
                  <span className="text-muted-foreground">
                    Check 3 question:{" "}
                  </span>
                  <MathText text={detail.secondQuestionText} />
                </p>
                <p>
                  <span className="text-muted-foreground">
                    Check 3 response:{" "}
                  </span>
                  {detail.check3SelectedText ? (
                    <>
                      <MathText text={detail.check3SelectedText} />{" "}
                      <Badge
                        variant={
                          detail.check3IsCorrect ? "success" : "destructive"
                        }
                      >
                        {detail.check3IsCorrect
                          ? "Correct"
                          : `Wrong${detail.check3Label ? ` (${detail.check3Label})` : ""}`}
                      </Badge>
                    </>
                  ) : (
                    <em className="text-muted-foreground">Not answered</em>
                  )}
                </p>
              </div>

              <div className="rounded bg-muted/50 p-2.5 text-xs space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">System Diagnosis:</span>
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
                  <p className="text-muted-foreground">
                    {detail.diagnosisReason}
                  </p>
                )}
              </div>

              <div className="space-y-1 text-xs">
                <p>
                  <span className="text-muted-foreground">
                    Held-out question:{" "}
                  </span>
                  <MathText text={detail.heldOutQuestionText} />
                </p>
                <p>
                  <span className="text-muted-foreground">
                    Held-out response:{" "}
                  </span>
                  {detail.heldOutSelectedText ? (
                    <>
                      <MathText text={detail.heldOutSelectedText} />{" "}
                      <Badge
                        variant={
                          detail.heldOutIsCorrect ? "success" : "destructive"
                        }
                      >
                        {detail.heldOutIsCorrect
                          ? "Correct"
                          : `Wrong${detail.heldOutLabel ? ` (${detail.heldOutLabel})` : ""}`}
                      </Badge>
                    </>
                  ) : (
                    <em className="text-muted-foreground">Not answered</em>
                  )}
                </p>
              </div>
            </section>

            {/* Tutoring Audit */}
            {detail.tutoringMessage && (
              <section className="rounded-lg border p-3.5 space-y-2">
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
                      <span className="text-xs font-mono text-muted-foreground">
                        {detail.tutorProvider}/{detail.tutorModel}
                      </span>
                    )}
                  </div>
                </div>
                <p className="whitespace-pre-wrap text-xs rounded bg-muted/40 p-2.5">
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
                          className="rounded border p-2 text-[11px] space-y-0.5"
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
            <section className="rounded-lg border p-3.5 space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Full Transcript ({detail.messages.length} turns)
              </h3>
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                {detail.messages.map((m) => (
                  <div
                    key={m.seq}
                    className="rounded bg-muted/40 px-2.5 py-1.5 text-xs space-y-0.5"
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
                    <p className="whitespace-pre-wrap">
                      <MathText text={m.content} />
                    </p>
                  </div>
                ))}
              </div>
            </section>

            {/* Instructor Review Decision Form */}
            <section className="rounded-lg border p-4 space-y-3 bg-muted/20">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  Instructor Review Decision
                </h3>
                <Badge
                  variant={
                    detail.reviewStatus === "REVIEWED" ? "success" : "secondary"
                  }
                >
                  {detail.reviewStatus}
                </Badge>
              </div>
              {!hasDiagnosis && (
                <p className="text-xs text-muted-foreground">
                  This session ended before a diagnosis was computed, so only
                  Escalated or Dismissed decisions apply.
                </p>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="coach-review-decision">Decision</Label>
                <select
                  id="coach-review-decision"
                  value={decision}
                  onChange={(e) =>
                    setDecision(e.target.value as CoachReviewDecision)
                  }
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  {availableDecisions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {decision === "OVERRIDE_MISCONCEPTION" && (
                <div className="space-y-1.5">
                  <Label htmlFor="coach-override-code">
                    Misconception Code
                  </Label>
                  <select
                    id="coach-override-code"
                    value={overrideCode}
                    onChange={(e) => setOverrideCode(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    {catalog.map((item) => (
                      <option
                        key={item.misconceptionId}
                        value={item.misconceptionId}
                      >
                        {item.misconceptionId}: {item.statement}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="coach-review-notes">
                  Review Notes (optional)
                </Label>
                <Textarea
                  id="coach-review-notes"
                  rows={3}
                  value={notes}
                  maxLength={2000}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional rationale, follow-up plan, or coding notes…"
                />
              </div>

              {savedMsg && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="size-3.5" />
                  {savedMsg}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={onClose} disabled={saving}>
                  Close
                </Button>
                <Button onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  Save Review
                </Button>
              </div>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
