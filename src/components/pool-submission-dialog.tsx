"use client";

import { useMemo, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface AdminOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface TopicOption {
  id: string;
  name: string;
}

interface ExistingSubmission {
  id: string;
  contentType: "QUIZ" | "MATERIAL";
  status: string;
  quizId: string | null;
  materialId: string | null;
  decisionNote: string | null;
  emailStatus: string;
  reviewer: AdminOption;
}

export function PoolSubmissionDialog({
  contentType,
  contentId,
  contentName,
  disabled = false,
}: {
  contentType: "QUIZ" | "MATERIAL";
  contentId: string;
  contentName: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [topics, setTopics] = useState<TopicOption[]>([]);
  const [submissions, setSubmissions] = useState<ExistingSubmission[]>([]);
  const [reviewerId, setReviewerId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const latest = useMemo(
    () =>
      submissions.find(
        (submission) =>
          submission.contentType === contentType &&
          (contentType === "QUIZ"
            ? submission.quizId === contentId
            : submission.materialId === contentId)
      ),
    [submissions, contentId, contentType]
  );

  async function loadOptions() {
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/pool-submissions", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load reviewers.");
      const data = await response.json();
      setAdmins(data.admins ?? []);
      setTopics(data.topics ?? []);
      setSubmissions(data.submissions ?? []);
      setReviewerId((current) => current || data.admins?.[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load reviewers.");
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) void loadOptions();
  }

  async function submit() {
    if (submitting || !reviewerId) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/pool-submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType, contentId, reviewerId, topicId: topicId || null }),
      });
      if (!response.ok) throw new Error("Could not submit the request.");
      const data = await response.json();
      const successMessage =
        data.emailWarning
          ? `Request saved, but the email could not be delivered: ${data.emailWarning}`
          : "Approval request sent to the selected administrator.";
      await loadOptions();
      setMessage(successMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit the request.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={disabled}>
          <Send className="size-3" /> Submit to pool
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit to the global pool</DialogTitle>
          <DialogDescription>
            Choose an administrator to review “{contentName}”. They will receive an email with a direct review link.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading reviewers…
          </div>
        ) : (
          <div className="space-y-4">
            {latest && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                Latest request: <span className="font-medium">{latest.status.toLowerCase()}</span> by {latest.reviewer.firstName} {latest.reviewer.lastName}.
                {latest.decisionNote && <p className="mt-1 text-muted-foreground">{latest.decisionNote}</p>}
              </div>
            )}
            <label className="block space-y-1.5 text-sm font-medium">
              Administrator
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={reviewerId}
                onChange={(event) => setReviewerId(event.target.value)}
              >
                {admins.length === 0 && <option value="">No administrators available</option>}
                {admins.map((admin) => (
                  <option key={admin.id} value={admin.id}>
                    {admin.firstName} {admin.lastName} — {admin.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              Global topic
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={topicId}
                onChange={(event) => setTopicId(event.target.value)}
              >
                <option value="">Match the item’s current topic (or no topic)</option>
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>{topic.name}</option>
                ))}
              </select>
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {message && <p className="text-sm text-primary">{message}</p>}
          </div>
        )}

        <DialogFooter>
          <Button
            onClick={submit}
            disabled={loading || submitting || !reviewerId || latest?.status === "PENDING"}
          >
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {latest?.status === "PENDING" ? "Awaiting review" : "Send approval request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
