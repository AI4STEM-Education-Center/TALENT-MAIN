"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Download, Eye, Settings, FileText } from "lucide-react";
import { useAlert } from "@/components/ui/confirm-dialog";

interface ConsentRecordRow {
  id: string;
  role: string;
  decision: string;
  signedAt: string;
  deviceType: string;
  ipAddress: string;
  interviewRecordingConsent: boolean | null;
  signerNameSnapshot: string;
  signerEmailSnapshot: string;
  formVersion: { title: string; version: string };
}

type JobState = { jobId: string; status: string; processedRecords: number; totalRecords: number | null; downloadUrl: string | null; error: string | null } | null;

export default function AdminConsentPage() {
  const alert = useAlert();
  const [records, setRecords] = useState<ConsentRecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string>("ALL");
  const [decision, setDecision] = useState<string>("ALL");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<JobState>(null);
  const [requestingExport, setRequestingExport] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ pageSize: "100" });
    if (role !== "ALL") params.set("role", role);
    if (decision !== "ALL") params.set("decision", decision);
    try {
      const res = await fetch(`/api/admin/consent?${params}`, { cache: "no-store" });
      const data = await res.json();
      setRecords(data.records ?? []);
    } finally {
      setLoading(false);
    }
  }, [role, decision]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll an in-flight bulk export job until it reaches a terminal state.
  useEffect(() => {
    if (!job || job.status === "COMPLETE" || job.status === "FAILED") return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/admin/consent/export/${job.jobId}`);
      if (!res.ok) return;
      const data = await res.json();
      setJob((prev) => (prev ? { ...prev, ...data } : prev));
    }, 2000);
    return () => clearInterval(timer);
  }, [job]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function requestExport() {
    if (selected.size === 0) return;
    setRequestingExport(true);
    try {
      const res = await fetch("/api/admin/consent/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter: { recordIds: Array.from(selected) } }),
      });
      const data = await res.json();
      if (!res.ok) {
        await alert({ title: "Couldn't start export", description: data?.error || "Unknown error." });
        return;
      }
      setJob({ jobId: data.jobId, status: "PENDING", processedRecords: 0, totalRecords: data.totalRecords, downloadUrl: null, error: null });
    } finally {
      setRequestingExport(false);
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Consent Records</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Only visible here and never to teachers. Preview one or two records instantly, or select several for a
            bulk PDF download — large exports run in the background so they never slow down the site.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/consent/forms"><FileText className="size-4" /> Form versions</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/consent/settings"><Settings className="size-4" /> Export settings</Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label className="text-xs">Role</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All roles</SelectItem>
              <SelectItem value="STUDENT">Student</SelectItem>
              <SelectItem value="TEACHER">Teacher</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Decision</Label>
          <Select value={decision} onValueChange={setDecision}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Any</SelectItem>
              <SelectItem value="AGREE">Agree</SelectItem>
              <SelectItem value="DECLINE">Decline</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={requestExport}
          disabled={selected.size === 0 || requestingExport || Boolean(job && job.status !== "COMPLETE" && job.status !== "FAILED")}
        >
          <Download className="size-4" /> Download {selected.size || ""} selected as ZIP
        </Button>
      </div>

      {job && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 py-4 text-sm">
            {job.status === "COMPLETE" ? (
              <>
                <span>Export ready ({job.totalRecords ?? job.processedRecords} records).</span>
                {job.downloadUrl && (
                  <Button size="sm" asChild>
                    <a href={job.downloadUrl}>Download zip</a>
                  </Button>
                )}
              </>
            ) : job.status === "FAILED" ? (
              <span className="text-destructive">Export failed: {job.error}</span>
            ) : (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>
                  Generating in the background — {job.processedRecords}
                  {job.totalRecords ? ` / ${job.totalRecords}` : ""} records processed.
                </span>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2"></th>
                <th className="p-2">Name</th>
                <th className="p-2">Role</th>
                <th className="p-2">Decision</th>
                <th className="p-2">Form</th>
                <th className="p-2">Signed at</th>
                <th className="p-2">Device</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td className="p-2">
                    <div>{r.signerNameSnapshot}</div>
                    <div className="text-xs text-muted-foreground">{r.signerEmailSnapshot}</div>
                  </td>
                  <td className="p-2">{r.role}</td>
                  <td className="p-2">{r.decision}</td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {r.formVersion.title} ({r.formVersion.version})
                  </td>
                  <td className="p-2 text-xs">{new Date(r.signedAt).toLocaleString()}</td>
                  <td className="p-2 text-xs capitalize">{r.deviceType}</td>
                  <td className="p-2 text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`/api/admin/consent/${r.id}/pdf`} target="_blank" rel="noreferrer">
                        <Eye className="size-4" />
                      </a>
                    </Button>
                  </td>
                </tr>
              ))}
              {records.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-muted-foreground">
                    No consent records match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
