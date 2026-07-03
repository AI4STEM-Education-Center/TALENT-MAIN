"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MathText } from "@/components/ui/math-text";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { SimulationStatusBadge } from "@/components/simulation/SimulationStatusBadge";
import { SimulationViewer } from "@/components/simulation/SimulationViewer";
import { Atom, ChevronDown, ChevronRight, Eye, Loader2, Play, RefreshCw, Sparkles } from "lucide-react";

interface Counts { ready: number; declined: number; failed: number; inFlight: number; missing: number }
interface QuizRow { id: string; name: string; topicName: string | null; questionCount: number; counts: Counts }
interface Summary { quizzes: QuizRow[]; totals: Counts }

interface SimDetail {
  id: string;
  status: string;
  topic: string | null;
  title: string | null;
  learningGoal: string | null;
  declineReason: string | null;
  errorMessage: string | null;
  version: number;
  hasContent: boolean;
  feedbackCount: number;
  aiModel: string | null;
}
interface QuestionRow { id: string; title: string | null; text: string; simulation: SimDetail | null }
interface QuizDetail { quiz: { id: string; name: string }; questions: QuestionRow[] }

interface PreviewState { simulationId: string; title: string; topic: string | null; learningGoal: string | null }

/** How many of this quiz's questions a plain (non-force) generate would touch. */
function generatable(counts: Counts): number {
  return counts.missing + counts.failed;
}

export function AdminSimulationsClient() {
  const confirm = useConfirm();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loadError, setLoadError] = useState("");
  const [msg, setMsg] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, QuizDetail>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const refreshSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/simulations");
      if (!res.ok) throw new Error();
      setSummary(await res.json());
      setLoadError("");
    } catch {
      setLoadError("Failed to load simulation status.");
    }
  }, []);

  const refreshDetail = useCallback(async (quizId: string) => {
    const res = await fetch(`/api/admin/simulations?quizId=${encodeURIComponent(quizId)}`);
    if (res.ok) {
      const detail: QuizDetail = await res.json();
      setDetails((prev) => ({ ...prev, [quizId]: detail }));
    }
  }, []);

  useEffect(() => {
    refreshSummary();
  }, [refreshSummary]);

  // While anything is generating, poll the summary + every expanded quiz so
  // statuses flip to READY/DECLINED/FAILED without a manual reload.
  const inFlight = (summary?.totals.inFlight ?? 0) > 0;
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      refreshSummary();
      for (const quizId of expanded) refreshDetail(quizId);
    }, 5000);
    return () => clearInterval(timer);
  }, [inFlight, expanded, refreshSummary, refreshDetail]);

  function toggleQuiz(quizId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(quizId)) next.delete(quizId);
      else {
        next.add(quizId);
        if (!details[quizId]) refreshDetail(quizId);
      }
      return next;
    });
  }

  async function generate(
    payload: { scope: "pool" } | { scope: "quiz"; quizId: string } | { scope: "question"; questionId: string; force?: boolean },
    busyKey: string,
    detailQuizId?: string
  ) {
    setBusy((prev) => new Set(prev).add(busyKey));
    try {
      const res = await fetch("/api/admin/simulations/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error ?? "Failed to start generation.");
        return;
      }
      const parts = [
        data.created > 0 ? `${data.created} queued` : null,
        data.retried > 0 ? `${data.retried} re-queued` : null,
        data.skipped > 0 ? `${data.skipped} skipped` : null,
        data.enqueueFailed > 0 ? `${data.enqueueFailed} failed to enqueue` : null,
      ].filter(Boolean);
      setMsg(parts.length > 0 ? `Generation started: ${parts.join(", ")}.` : "Nothing to generate.");
      await refreshSummary();
      if (detailQuizId) await refreshDetail(detailQuizId);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(busyKey);
        return next;
      });
    }
  }

  async function regenerate(question: QuestionRow, quizId: string) {
    const sim = question.simulation;
    const stuck = sim && (sim.status === "PENDING" || sim.status === "REVISING");
    const ok = await confirm({
      title: stuck ? "Restart this generation?" : "Regenerate this simulation?",
      description: stuck
        ? "Use this only when a job looks stuck (e.g. the worker restarted). The current job's result will be discarded."
        : "The current simulation (and its decline decision, if any) is replaced by a fresh generation. Teachers' imported copies are not affected.",
      confirmText: stuck ? "Restart" : "Regenerate",
    });
    if (!ok) return;
    await generate({ scope: "question", questionId: question.id, force: true }, `q:${question.id}`, quizId);
  }

  if (!summary) {
    return (
      <div className="p-4 md:p-6">
        {loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading simulation status…
          </p>
        )}
      </div>
    );
  }

  const totals = summary.totals;
  const poolGeneratable = generatable(totals);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Simulations</h1>
        <p className="text-muted-foreground text-sm mt-1">
          AI-generated interactive simulations, one per pool question, teaching each question&apos;s broad
          topic — never the question itself. Teachers receive them with imported quizzes; students see them
          after submitting a quiz.
        </p>
      </div>

      {msg && <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>}
      {loadError && <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{loadError}</div>}

      {/* Pool-wide status + the global trigger */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Atom className="size-4 text-muted-foreground" />
            <Badge variant="success">{totals.ready} ready</Badge>
            <Badge variant="secondary">{totals.declined} declined</Badge>
            {totals.failed > 0 && <Badge variant="destructive">{totals.failed} failed</Badge>}
            {totals.inFlight > 0 && (
              <Badge variant="outline">
                <Loader2 className="size-3 mr-1 animate-spin" /> {totals.inFlight} generating
              </Badge>
            )}
            <Badge variant="outline">{totals.missing} without simulation</Badge>
          </div>
          <Button
            onClick={() => generate({ scope: "pool" }, "pool")}
            disabled={busy.has("pool") || poolGeneratable === 0}
            className="shrink-0"
          >
            {busy.has("pool") ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Generate missing ({poolGeneratable})
          </Button>
        </CardContent>
      </Card>

      {summary.quizzes.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 text-muted-foreground">
            <Atom className="size-10 mx-auto mb-3" />
            <p>The global pool has no quizzes yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {summary.quizzes.map((quiz) => {
            const isOpen = expanded.has(quiz.id);
            const detail = details[quiz.id];
            const quizGeneratable = generatable(quiz.counts);
            return (
              <Card key={quiz.id}>
                <div className="flex items-center gap-2 p-4">
                  <button
                    type="button"
                    onClick={() => toggleQuiz(quiz.id)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    {isOpen ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                    <span className="min-w-0">
                      <span className="font-semibold block truncate">{quiz.name}</span>
                      <span className="mt-1 flex flex-wrap gap-2">
                        {quiz.topicName && <Badge variant="outline">{quiz.topicName}</Badge>}
                        <Badge variant="success">{quiz.counts.ready}/{quiz.questionCount} ready</Badge>
                        {quiz.counts.declined > 0 && <Badge variant="secondary">{quiz.counts.declined} declined</Badge>}
                        {quiz.counts.failed > 0 && <Badge variant="destructive">{quiz.counts.failed} failed</Badge>}
                        {quiz.counts.inFlight > 0 && (
                          <Badge variant="outline">
                            <Loader2 className="size-3 mr-1 animate-spin" /> {quiz.counts.inFlight}
                          </Badge>
                        )}
                      </span>
                    </span>
                  </button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    disabled={busy.has(`quiz:${quiz.id}`) || quizGeneratable === 0}
                    onClick={() => generate({ scope: "quiz", quizId: quiz.id }, `quiz:${quiz.id}`, quiz.id)}
                  >
                    {busy.has(`quiz:${quiz.id}`) ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                    Generate ({quizGeneratable})
                  </Button>
                </div>

                {isOpen && (
                  <div className="border-t p-3 space-y-2">
                    {!detail ? (
                      <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> Loading questions…
                      </p>
                    ) : (
                      detail.questions.map((question, index) => {
                        const sim = question.simulation;
                        const qBusy = busy.has(`q:${question.id}`);
                        return (
                          <div key={question.id} className="rounded-md border p-3">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="text-sm line-clamp-2">
                                  <span className="mr-1 text-muted-foreground">{index + 1}.</span>
                                  <MathText text={question.title || question.text} />
                                </p>
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <SimulationStatusBadge status={sim?.status ?? null} />
                                  {sim?.title && (
                                    <span className="text-xs text-muted-foreground truncate">
                                      {sim.title}
                                      {sim.topic ? ` — ${sim.topic}` : ""}
                                      {sim.version > 1 ? ` (v${sim.version})` : ""}
                                    </span>
                                  )}
                                  {sim && sim.feedbackCount > 0 && (
                                    <Badge variant="outline">{sim.feedbackCount} feedback</Badge>
                                  )}
                                </div>
                                {sim?.status === "DECLINED" && sim.declineReason && (
                                  <p className="mt-1 text-xs italic text-muted-foreground">{sim.declineReason}</p>
                                )}
                                {sim?.status === "FAILED" && sim.errorMessage && (
                                  <p className="mt-1 text-xs text-destructive">{sim.errorMessage}</p>
                                )}
                              </div>
                              <div className="flex shrink-0 gap-1">
                                {sim?.hasContent && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      setPreview({
                                        simulationId: sim.id,
                                        title: sim.title ?? "Simulation preview",
                                        topic: sim.topic,
                                        learningGoal: sim.learningGoal,
                                      })
                                    }
                                  >
                                    <Eye className="size-3" /> Preview
                                  </Button>
                                )}
                                {(!sim || sim.status === "FAILED") && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={qBusy}
                                    onClick={() => generate({ scope: "question", questionId: question.id }, `q:${question.id}`, quiz.id)}
                                  >
                                    {qBusy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                                    {sim?.status === "FAILED" ? "Retry" : "Generate"}
                                  </Button>
                                )}
                                {sim && sim.status !== "FAILED" && (
                                  <Button size="sm" variant="ghost" disabled={qBusy} onClick={() => regenerate(question, quiz.id)}>
                                    {qBusy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                                    {sim.status === "PENDING" || sim.status === "REVISING" ? "Restart" : "Regenerate"}
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Full-size sandboxed preview */}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="flex h-[85vh] max-w-5xl flex-col">
          <DialogHeader>
            <DialogTitle>{preview?.title}</DialogTitle>
            {(preview?.topic || preview?.learningGoal) && (
              <DialogDescription>
                {preview?.topic}
                {preview?.topic && preview?.learningGoal ? " — " : ""}
                {preview?.learningGoal}
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="min-h-0 flex-1">
            {preview && <SimulationViewer simulationId={preview.simulationId} title={preview.title} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
