"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Check, Inbox, Loader2, X } from "lucide-react";

interface RequestRow {
  id: string;
  gradeColumnName: string;
  pointsAwarded: number;
  status: string;
  decisionNote: string | null;
  requestedAt: string;
  teacher: { user: { firstName: string; lastName: string; email: string } };
  class: { id: string; name: string };
}

export default function AdminConsentRequestsPage() {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [attested, setAttested] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/consent-requests", { cache: "no-store", signal });
      if (!res.ok) throw new Error("Could not load consent export requests.");
      const data = await res.json();
      setRequests(data.requests ?? []);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not load consent export requests.");
    } finally {
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- the reset is already inside this function's finally block; detector misfire
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  async function decide(id: string, decision: "APPROVE" | "REJECT") {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/consent-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          note: notes[id] || "",
          courseEndedAttested: decision === "APPROVE" ? attested[id] === true : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not save the decision.");
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the decision.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-3xl font-bold">Consent Export Requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Teachers requesting a signed-students credit export, routed to you. Approving an export releases only an
          aggregate credit-points outcome to the teacher — never individual decision detail.
        </p>
      </div>

      {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Inbox className="mx-auto mb-3 size-10" />
            No requests are assigned to you.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => {
            const pending = request.status === "PENDING";
            return (
              <Card key={request.id}>
                <CardContent className="space-y-4 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold">{request.class.name}</h2>
                      <p className="text-sm text-muted-foreground">
                        From {request.teacher.user.firstName} {request.teacher.user.lastName} (
                        {request.teacher.user.email})
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Grade column: {request.gradeColumnName} ({request.pointsAwarded} points) ·{" "}
                        {new Date(request.requestedAt).toLocaleString()}
                      </p>
                    </div>
                    <Badge
                      variant={
                        request.status === "APPROVED" ? "default" : request.status === "REJECTED" ? "destructive" : "secondary"
                      }
                    >
                      {request.status}
                    </Badge>
                  </div>

                  {pending ? (
                    <div className="space-y-3">
                      <label className="flex items-start gap-2 rounded-md bg-amber-500/10 p-3 text-sm">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4"
                          checked={attested[request.id] === true}
                          onChange={(e) =>
                            setAttested((prev) => ({ ...prev, [request.id]: e.target.checked }))
                          }
                        />
                        <span>
                          I confirm this course has ended and final grades have been submitted, per the signed
                          consent form&apos;s commitment that a student&apos;s participation is never known to
                          their instructor while enrolled. Approval is disabled until this is checked.
                        </span>
                      </label>
                      <Textarea
                        value={notes[request.id] || ""}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [request.id]: e.target.value }))}
                        placeholder="Optional note to the teacher"
                      />
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" disabled={busyId === request.id} onClick={() => decide(request.id, "REJECT")}>
                          <X className="size-4" /> Reject
                        </Button>
                        <Button
                          disabled={busyId === request.id || attested[request.id] !== true}
                          onClick={() => decide(request.id, "APPROVE")}
                        >
                          {busyId === request.id ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                          Approve and send to teacher
                        </Button>
                      </div>
                    </div>
                  ) : request.decisionNote ? (
                    <p className="rounded-md bg-muted/50 p-3 text-sm">{request.decisionNote}</p>
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
