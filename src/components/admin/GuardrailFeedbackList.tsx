"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquareWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format-date";
import { cn } from "@/lib/utils";

type Status = "NEW" | "REVIEWED" | "DISMISSED";

type FeedbackRow = {
  id: string;
  createdAt: string;
  message: string;
  status: Status;
  surface: string;
  surfaceLabel: string;
  subjectId: string | null;
  blocked: boolean;
  reasons: string[];
  user: { name: string | null; email: string | null; role: string } | null;
};

const FILTERS: { value: Status | "ALL"; label: string }[] = [
  { value: "NEW", label: "New" },
  { value: "REVIEWED", label: "Reviewed" },
  { value: "DISMISSED", label: "Dismissed" },
  { value: "ALL", label: "All" },
];

/**
 * What users said when a safety check stopped them.
 *
 * The log rows above say how OFTEN a check fires. Only these say whether it was
 * RIGHT — which is the question that actually decides whether a check is ready
 * to move from Report to Block. A queue of "this was my homework question"
 * reports means the threshold is too low, and no reports against a busy check
 * means it is landing where it should.
 */
export function GuardrailFeedbackList() {
  const [filter, setFilter] = useState<Status | "ALL">("NEW");
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const query = filter === "ALL" ? "" : `?status=${filter}`;
      const res = await fetch(`/api/admin/guardrails/feedback${query}`);
      if (!res.ok) throw new Error("Failed to load guardrail feedback");
      const data: { feedback: FeedbackRow[] } = await res.json();
      setRows(data.feedback);
    } catch {
      setRows([]);
      setError("Could not load guardrail feedback.");
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setStatus(id: string, status: Status) {
    setBusyId(id);
    try {
      const res = await fetch("/api/admin/guardrails/feedback", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) throw new Error("Failed");
      await load();
    } catch {
      setError("Could not update that report.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquareWarning className="h-5 w-5" /> Guardrail reports
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Users who were stopped by a safety check and said it was wrong. Read these before
          switching a check from <em>Report</em> to <em>Block</em> — they are the only signal that
          says whether a check was <em>right</em>, rather than just how often it fired.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              aria-pressed={filter === option.value}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                filter === option.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-accent"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {rows === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing here. Either the checks are landing well or nobody has been stopped yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{row.surfaceLabel}</span>
                  <span>{row.blocked ? "blocked" : "warned"}</span>
                  <span>·</span>
                  <span>{formatDateTime(row.createdAt)}</span>
                  {row.user && (
                    <>
                      <span>·</span>
                      <span>
                        {row.user.name || row.user.email || "unknown"} ({row.user.role})
                      </span>
                    </>
                  )}
                </div>

                <p className="mt-2 whitespace-pre-wrap">{row.message}</p>

                <p className="mt-2 text-xs text-muted-foreground">
                  Check said:{" "}
                  {row.reasons.length > 0 ? row.reasons.join(", ") : "no reason recorded"}
                  {row.subjectId && ` · ${row.subjectId}`}
                </p>

                <div className="mt-2 flex flex-wrap gap-2">
                  {row.status !== "REVIEWED" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === row.id}
                      onClick={() => setStatus(row.id, "REVIEWED")}
                    >
                      {busyId === row.id && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                      Mark reviewed
                    </Button>
                  )}
                  {row.status !== "DISMISSED" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === row.id}
                      onClick={() => setStatus(row.id, "DISMISSED")}
                    >
                      Dismiss
                    </Button>
                  )}
                  {row.status !== "NEW" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === row.id}
                      onClick={() => setStatus(row.id, "NEW")}
                    >
                      Reopen
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
