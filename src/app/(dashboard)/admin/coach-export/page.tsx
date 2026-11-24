"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileUp, Loader2, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface ExportSummary {
  totalMatchingSessions: number;
  consentingExportableSessions: number;
  excludedNonConsentingSessions: number;
  classes: Array<{ id: string; name: string }>;
}

export default function AdminCoachExportPage() {
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [classId, setClassId] = useState("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [includeIncomplete, setIncludeIncomplete] = useState(false);
  const [redaction, setRedaction] = useState<"redacted" | "raw_irb">(
    "redacted",
  );

  const buildQuery = useCallback(
    (format: "summary" | "jsonl" | "csv") => {
      const sp = new URLSearchParams();
      sp.set("format", format);
      sp.set("redaction", redaction);
      if (classId !== "ALL") sp.set("classId", classId);
      if (from) sp.set("from", from);
      if (to) sp.set("to", to);
      if (includeIncomplete) sp.set("includeIncomplete", "true");
      return `/api/admin/coach-export?${sp.toString()}`;
    },
    [classId, from, to, includeIncomplete, redaction],
  );

  const abortRef = useRef<AbortController | null>(null);

  const loadSummary = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(buildQuery("summary"), {
        signal: controller.signal,
      });
      const data = (await res.json()) as ExportSummary & { error?: string };
      if (controller.signal.aborted) return;
      if (!res.ok) {
        throw new Error(data.error || "Could not load export summary.");
      }
      setSummary(data);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Failed to load summary.");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [buildQuery]);

  useEffect(() => {
    void loadSummary();
    return () => {
      abortRef.current?.abort();
    };
  }, [loadSummary]);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FileUp className="size-6" />
          Wrong Answer Coach — IRB Research Export
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Export de-identified diagnostic records strictly for students with
          verified active research consent. Every download is logged to the
          system audit log.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="size-4 text-emerald-600" />
            Export Filters &amp; De-Identification Controls
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="export-class">Class</Label>
              <select
                id="export-class"
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="ALL">All classes</option>
                {(summary?.classes ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="export-from">From Date</Label>
              <Input
                id="export-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="export-to">To Date</Label>
              <Input
                id="export-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="export-redaction">Free-Text Redaction</Label>
              <select
                id="export-redaction"
                value={redaction}
                onChange={(e) =>
                  setRedaction(e.target.value as "redacted" | "raw_irb")
                }
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="redacted">
                  Redacted (default — scrubs emails, IDs, phones &amp; student
                  names)
                </option>
                <option value="raw_irb">
                  Raw IRB-Authorized Free Text (containsUnredactedFreeText:
                  true)
                </option>
              </select>
            </div>

            <div className="flex items-end pb-1.5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeIncomplete}
                  onChange={(e) => setIncludeIncomplete(e.target.checked)}
                />
                Include incomplete / abandoned sessions
              </label>
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Calculating consenting session counts…
            </div>
          ) : (
            summary && (
              <div className="rounded-lg border bg-muted/30 p-4 flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">Matching: </span>
                    <strong>{summary.totalMatchingSessions}</strong>
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      Consenting (exportable):{" "}
                    </span>
                    <Badge variant="success">
                      {summary.consentingExportableSessions}
                    </Badge>
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      Excluded (non-consenting):{" "}
                    </span>
                    <Badge variant="secondary">
                      {summary.excludedNonConsentingSessions}
                    </Badge>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <a href={buildQuery("jsonl")}>
                      <Download className="size-4" />
                      Download JSONL (full)
                    </a>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <a href={buildQuery("csv")}>
                      <Download className="size-4" />
                      Download CSV (flat)
                    </a>
                  </Button>
                </div>
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
