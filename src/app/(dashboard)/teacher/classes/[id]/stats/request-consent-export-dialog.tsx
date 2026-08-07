"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAlert } from "@/components/ui/confirm-dialog";

interface AdminOption {
  id: string;
  firstName: string;
  lastName: string;
}

interface RequestRow {
  id: string;
  status: string;
  gradeColumnName: string;
  pointsAwarded: number;
  requestedAt: string;
}

/**
 * Lets a teacher request an eLC-importable credit-points export of which
 * students signed the consent form — routed through a chosen admin for
 * approval, never self-service. See docs/plans/consent-compliance-plan.md §7:
 * the teacher never sees per-student decisions, only the eventual approved
 * credit-points file.
 */
export function RequestConsentExportDialog({ classId }: { classId: string }) {
  const alert = useAlert();
  const [open, setOpen] = useState(false);
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [gradeColumnName, setGradeColumnName] = useState("");
  const [pointsAwarded, setPointsAwarded] = useState("5");
  const [reviewerId, setReviewerId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch(`/api/classes/${classId}/consent-export-request`)
      .then((res) => res.json())
      .then((data) => {
        setAdmins(data.admins ?? []);
        setRequests(data.requests ?? []);
      });
  }, [open, classId]);

  const pending = requests.find((r) => r.status === "PENDING");
  const points = Number(pointsAwarded);
  const pointsValid = Number.isFinite(points) && points > 0 && points <= 1_000_000;

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/classes/${classId}/consent-export-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gradeColumnName: gradeColumnName.trim(), pointsAwarded: points, reviewerId }),
      });
      const data = await res.json();
      if (!res.ok) {
        await alert({ title: "Couldn't submit request", description: data?.error || "Unknown error." });
        return;
      }
      setRequests((prev) => [data.request, ...prev]);
      setGradeColumnName("");
      await alert("Request sent. You'll get an email with the credit file once an administrator approves it.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ShieldCheck className="size-4" /> Request signed-students export
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a signed-students credit export</DialogTitle>
            <DialogDescription>
              An administrator reviews and approves every request. You&apos;ll receive an eLC-importable CSV with
              credit points for students who signed — never a list of individual decisions.
            </DialogDescription>
          </DialogHeader>

          {pending ? (
            <p className="rounded-md bg-muted/50 p-3 text-sm">
              A request for this class is already pending review ({pending.gradeColumnName}, {pending.pointsAwarded}{" "}
              points, requested {new Date(pending.requestedAt).toLocaleDateString()}).
            </p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="consent-grade-column">Grade column name</Label>
                <Input
                  id="consent-grade-column"
                  value={gradeColumnName}
                  onChange={(e) => setGradeColumnName(e.target.value)}
                  placeholder="Consent Credit"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="consent-points">Points awarded</Label>
                <Input
                  id="consent-points"
                  type="number"
                  min="0.01"
                  max="1000000"
                  step="any"
                  value={pointsAwarded}
                  onChange={(e) => setPointsAwarded(e.target.value)}
                  aria-invalid={!pointsValid}
                />
              </div>
              <div className="space-y-2">
                <Label>Send to administrator</Label>
                <Select value={reviewerId} onValueChange={setReviewerId}>
                  <SelectTrigger><SelectValue placeholder="Choose an administrator" /></SelectTrigger>
                  <SelectContent>
                    {admins.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.firstName} {a.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            {!pending && (
              <Button
                onClick={submit}
                disabled={submitting || !gradeColumnName.trim() || !pointsValid || !reviewerId}
              >
                {submitting ? "Sending…" : "Send request"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
