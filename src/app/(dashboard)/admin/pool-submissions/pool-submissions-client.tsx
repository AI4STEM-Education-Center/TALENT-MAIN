"use client";

import { useState } from "react";
import { Check, FileQuestion, FileText, Inbox, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

export interface Submission {
  id: string;
  contentType: string;
  status: string;
  decisionNote: string | null;
  emailStatus: string;
  createdAt: string;
  teacher: { user: { firstName: string; lastName: string; email: string } };
  quiz: { id: string; name: string; _count: { questions: number } } | null;
  material: {
    id: string;
    title: string | null;
    originalName: string;
    totalPages: number;
  } | null;
  topic: { id: string; name: string } | null;
}

export function PoolSubmissionsClient({
  initialSubmissions,
  requestedId,
}: {
  initialSubmissions: Submission[];
  requestedId: string | null;
}) {
  const [submissions, setSubmissions] =
    useState<Submission[]>(initialSubmissions);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/pool-submissions", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not load approval requests.");
      const data = await response.json();
      setSubmissions(data.submissions ?? []);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load approval requests.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function decide(id: string, decision: "APPROVE" | "REJECT") {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch(`/api/pool-submissions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: notes[id] || "" }),
      });
      if (!response.ok) throw new Error("Could not save the decision.");
      await response.json();
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save the decision.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-3xl font-bold">Global pool approvals</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review quiz and learning-material submissions assigned to you.
        </p>
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading requests…
        </div>
      ) : submissions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Inbox className="mx-auto mb-3 size-10" />
            No requests are assigned to you.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {submissions.map((submission) => {
            const title =
              submission.quiz?.name ||
              submission.material?.title ||
              submission.material?.originalName ||
              "Deleted content";
            const pending = submission.status === "PENDING";
            return (
              <Card
                key={submission.id}
                className={
                  requestedId === submission.id
                    ? "ring-2 ring-primary"
                    : undefined
                }
              >
                <CardContent className="space-y-4 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 gap-3">
                      <div className="rounded-md bg-muted p-2">
                        {submission.contentType === "QUIZ" ? (
                          <FileQuestion className="size-5" />
                        ) : (
                          <FileText className="size-5" />
                        )}
                      </div>
                      <div>
                        <h2 className="font-semibold">{title}</h2>
                        <p className="text-sm text-muted-foreground">
                          From {submission.teacher.user.firstName}{" "}
                          {submission.teacher.user.lastName} (
                          {submission.teacher.user.email})
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {submission.quiz
                            ? `${submission.quiz._count.questions} questions`
                            : `${submission.material?.totalPages ?? 0} pages`}
                          {` · Topic: ${submission.topic?.name ?? "Match source / No topic"}`}
                          {` · ${new Date(submission.createdAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`}
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant={
                        submission.status === "APPROVED"
                          ? "default"
                          : submission.status === "REJECTED"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {submission.status}
                    </Badge>
                  </div>
                  {pending ? (
                    <div className="space-y-3">
                      <Textarea
                        value={notes[submission.id] || ""}
                        onChange={(event) =>
                          setNotes((current) => ({
                            ...current,
                            [submission.id]: event.target.value,
                          }))
                        }
                        placeholder="Optional note to the teacher"
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          disabled={busyId === submission.id}
                          onClick={() => decide(submission.id, "REJECT")}
                        >
                          <X className="size-4" /> Reject
                        </Button>
                        <Button
                          disabled={busyId === submission.id}
                          onClick={() => decide(submission.id, "APPROVE")}
                        >
                          {busyId === submission.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Check className="size-4" />
                          )}{" "}
                          Approve and publish
                        </Button>
                      </div>
                    </div>
                  ) : submission.decisionNote ? (
                    <p className="rounded-md bg-muted/50 p-3 text-sm">
                      {submission.decisionNote}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
