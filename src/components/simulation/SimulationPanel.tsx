"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SimulationViewer } from "@/components/simulation/SimulationViewer";
import { AiMetricsLine } from "@/components/ai-metrics-line";
import type { DisplayAiMetrics } from "@/lib/ai-metrics";
import { Loader2, Send, Trash2 } from "lucide-react";
import { GuardrailFeedbackButton } from "@/components/guardrails/GuardrailFeedbackButton";
import { FeedbackRatingForm } from "@/components/feedback/FeedbackRatingForm";
import { MyFeedbackProvider } from "@/components/feedback/my-feedback";

interface FeedbackRound {
  id: string;
  authorName: string | null;
  feedback: string;
  status: string; // PENDING | APPLIED | FAILED
  errorMessage: string | null;
  createdAt: string;
}

interface SimDetail {
  id: string;
  status: string;
  topic: string | null;
  title: string | null;
  learningGoal: string | null;
  declineReason: string | null;
  version: number;
  hasContent: boolean;
  aiMetrics: DisplayAiMetrics;
  feedback: FeedbackRound[];
}

interface SimulationPanelProps {
  simulationId: string;
  canGiveFeedback: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** How often to re-fetch while the worker revises the simulation. */
const SIMULATION_REVISION_POLL_INTERVAL_MS = 5_000;

/**
 * Dialog for interacting with one question's simulation: the sandboxed
 * artifact, its topic/goal, the feedback history, and — when the caller may
 * manage the quiz — a feedback form that sends the simulation into a revision
 * round. Polls while a revision is running so the new version appears in
 * place. Used by the teacher/admin quiz editor.
 */
export function SimulationPanel({
  simulationId,
  canGiveFeedback,
  open,
  onOpenChange,
}: SimulationPanelProps) {
  const confirm = useConfirm();
  const [detail, setDetail] = useState<SimDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsgText] = useState("");
  // Paired with `msg`: set only when a safety check refused the feedback, and
  // cleared by every other message so the report button cannot outlive it.
  const [guardrailEventId, setGuardrailEventId] = useState<string | null>(null);
  const setMsg = (text: string, eventId: string | null = null) => {
    setMsgText(text);
    setGuardrailEventId(eventId);
  };

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/simulations/${simulationId}`);
    if (res.ok) setDetail(await res.json());
    else setMsg("Failed to load the simulation.");
  }, [simulationId]);

  // Callers mount this component fresh per opening (see QuizEditor), so state
  // starts empty and this only needs to kick off the initial load.
  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  // While the worker is revising, poll so the new version swaps in (the
  // viewer's ?v= cache-buster changes with detail.version).
  const revising = detail?.status === "REVISING";
  useEffect(() => {
    if (!open || !revising) return;
    const timer = setInterval(refresh, SIMULATION_REVISION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [open, revising, refresh]);

  async function sendFeedback() {
    if (!draft.trim()) return;
    setSending(true);
    setMsg("");
    try {
      const res = await fetch(`/api/simulations/${simulationId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: draft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(
          data.error ?? "Failed to send feedback.",
          data.guardrailEventId ?? null,
        );
        return;
      }
      setDraft("");
      await refresh();
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Delete this simulation?",
      description:
        "This simulation and its feedback history are permanently removed from this question. This cannot be undone.",
      confirmText: "Delete",
    });
    if (!ok) return;
    setDeleting(true);
    setMsg("");
    try {
      const res = await fetch(`/api/simulations/${simulationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMsg(data.error ?? "Failed to delete the simulation.");
        return;
      }
      // Closing triggers the parent's refresh (see QuizEditor onOpenChange).
      onOpenChange(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-5xl flex-col">
        <DialogHeader>
          <DialogTitle>{detail?.title ?? "Simulation"}</DialogTitle>
          {(detail?.topic || detail?.learningGoal) && (
            <DialogDescription>
              {detail?.topic}
              {detail?.topic && detail?.learningGoal ? " — " : ""}
              {detail?.learningGoal}
            </DialogDescription>
          )}
          {detail && (
            <AiMetricsLine
              metrics={detail.aiMetrics}
              prefix="Generated by "
              className="text-xs text-muted-foreground"
            />
          )}
        </DialogHeader>

        {msg && (
          <p className="text-sm text-destructive">
            {msg}
            <GuardrailFeedbackButton
              eventId={guardrailEventId}
              className="ml-2"
            />
          </p>
        )}

        {!detail ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : detail.status === "DECLINED" ? (
          <div className="rounded-md border p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              No simulation for this question.
            </p>
            <p className="mt-1 italic">
              {detail.declineReason ??
                "The generator decided a simulation would not aid understanding here."}
            </p>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1">
              {detail.hasContent ? (
                // key + ?v= swap in a fresh document when a revision lands.
                <div key={detail.version} className="h-full">
                  <SimulationViewer
                    simulationId={detail.id}
                    title={detail.title ?? "Simulation"}
                    version={detail.version}
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  This simulation has no content yet.
                </p>
              )}
            </div>

            {revising && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Revision in progress — the current version stays available until
                the new one lands.
              </p>
            )}

            {detail.feedback.length > 0 && (
              <div className="max-h-32 space-y-2 overflow-y-auto rounded-md border p-3">
                {detail.feedback.map((f) => (
                  <div key={f.id} className="text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {f.authorName ?? "Reviewer"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(f.createdAt).toLocaleString()}
                      </span>
                      {f.status === "APPLIED" && (
                        <Badge variant="success">Applied</Badge>
                      )}
                      {f.status === "PENDING" && (
                        <Badge variant="outline">In progress</Badge>
                      )}
                      {f.status === "FAILED" && (
                        <Badge variant="destructive">Failed</Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground">{f.feedback}</p>
                    {f.status === "FAILED" && f.errorMessage && (
                      <p className="text-xs text-destructive">
                        {f.errorMessage}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Two different things live below, and keeping them apart matters:
                this RATING is a quality verdict that goes to the consolidated
                Feedback panel and the CSV export, and changes nothing about
                the artifact. The "report a problem" box under it queues a
                revision job that rewrites the simulation. */}
            {canGiveFeedback && detail.status === "READY" && (
              <div className="space-y-2 border-t pt-3">
                <p className="text-sm font-medium">
                  Rate this simulation — how useful is it for teaching this
                  topic?
                </p>
                <MyFeedbackProvider simulationId={simulationId}>
                  <FeedbackRatingForm
                    subjectType="SIMULATION"
                    subjectId={simulationId}
                    subjectLabel={detail.title ?? detail.topic ?? "Simulation"}
                    subjectDetail={detail.learningGoal ?? detail.topic}
                    prompt="How useful is it?"
                    commentPlaceholder='In a sentence or two — e.g. "Good visual for the phase relationship, but the damping slider moves too little to be worth showing."'
                  />
                </MyFeedbackProvider>
              </div>
            )}

            {canGiveFeedback && detail.status === "READY" && (
              <div className="space-y-2">
                <Label htmlFor="sim-feedback">
                  Report a problem — wrong physics/math, layout issues, or
                  anything to correct
                </Label>
                <div className="flex gap-2">
                  <Textarea
                    id="sim-feedback"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={2}
                    placeholder='e.g. "The period should use T = 2π√(L/g); it currently ignores L."'
                    className="flex-1"
                  />
                  <Button
                    onClick={sendFeedback}
                    disabled={sending || !draft.trim()}
                    className="shrink-0 self-end"
                  >
                    {sending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    Send
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {detail && canGiveFeedback && (
          <div className="flex justify-end border-t pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={deleting || sending}
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4 text-destructive" />
              )}
              Delete simulation
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
