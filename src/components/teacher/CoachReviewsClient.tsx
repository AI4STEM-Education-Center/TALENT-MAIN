"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ClipboardCheck,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CoachReviewDetailDrawer } from "@/components/teacher/CoachReviewDetailDrawer";
import {
  COACH_FLAG_CODES,
  type CoachFlagCode,
} from "@/lib/wrong-answer-coach-types";

interface CoachSessionRow {
  id: string;
  classId: string;
  className: string;
  quizId: string;
  quizName: string;
  questionNumber: number;
  studentName: string;
  state: string;
  endedReason: string | null;
  startedAt: string;
  completedAt: string | null;
  check1Label: string | null;
  check2ResultKind: string | null;
  check2MisconceptionCode: string | null;
  check2TopVoteCount: number | null;
  check2WasTie: boolean;
  check3IsCorrect: boolean | null;
  check3Label: string | null;
  diagnosis: string | null;
  diagnosisMisconceptionCode: string | null;
  decisionTableRow: number | null;
  heldOutIsCorrect: boolean | null;
  tutoringUsedFallback: boolean;
  flags: CoachFlagCode[];
  hasUrgentSupport: boolean;
}

export function CoachReviewsClient({
  apiBasePath,
  heading = "Wrong Answer Coach Sessions",
  subheading = "View recorded diagnostic sessions and 5-run Decisions API classifications.",
}: {
  apiBasePath: string;
  heading?: string;
  subheading?: string;
}) {
  const [sessions, setSessions] = useState<CoachSessionRow[]>([]);
  const [classes, setClasses] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [classId, setClassId] = useState("ALL");
  const [diagnosis, setDiagnosis] = useState("ALL");
  const [flagType, setFlagType] = useState("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set("flaggedOnly", String(flaggedOnly));
    params.set("reviewStatus", "ALL");
    if (classId !== "ALL") params.set("classId", classId);
    if (diagnosis !== "ALL") params.set("diagnosis", diagnosis);
    if (flagType !== "ALL") params.set("flagType", flagType);

    try {
      const res = await fetch(`${apiBasePath}?${params.toString()}`, {
        signal: controller.signal,
      });
      const data = (await res.json()) as {
        sessions?: CoachSessionRow[];
        classes?: Array<{ id: string; name: string }>;
        error?: string;
      };
      if (controller.signal.aborted) return;
      if (!res.ok) {
        throw new Error(data.error || "Could not load coach sessions.");
      }
      setSessions(data.sessions ?? []);
      setClasses(data.classes ?? []);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Failed to load sessions.");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [apiBasePath, flaggedOnly, classId, diagnosis, flagType]);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  const urgentCount = sessions.filter((s) => s.hasUrgentSupport).length;

  return (
    <div className="p-4 md:p-8">
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <ClipboardCheck className="size-6" />
              {heading}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{subheading}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </div>

        {urgentCount > 0 && (
          <div
            role="alert"
            className="flex items-center gap-2.5 rounded-lg border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              <strong>
                {urgentCount} session{urgentCount === 1 ? "" : "s"}
              </strong>{" "}
              triggered a personal-support safety flag.
            </span>
          </div>
        )}

        {/* Filters */}
        <Card>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="filter-scope" className="text-xs">
                Scope
              </Label>
              <select
                id="filter-scope"
                value={flaggedOnly ? "FLAGGED" : "ALL"}
                onChange={(e) => setFlaggedOnly(e.target.value === "FLAGGED")}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="ALL">All sessions</option>
                <option value="FLAGGED">Flagged only</option>
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="filter-class" className="text-xs">
                Class
              </Label>
              <select
                id="filter-class"
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="ALL">All classes</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="filter-diagnosis" className="text-xs">
                Diagnosis
              </Label>
              <select
                id="filter-diagnosis"
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value)}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="ALL">All diagnoses</option>
                <option value="SLIP">Slip</option>
                <option value="KNOWLEDGE_GAP">Knowledge Gap</option>
                <option value="MISCONCEPTION">Misconception</option>
                <option value="NONE">None (incomplete)</option>
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="filter-flag" className="text-xs">
                Flag Type
              </Label>
              <select
                id="filter-flag"
                value={flagType}
                onChange={(e) => setFlagType(e.target.value)}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              >
                <option value="ALL">All flags</option>
                {COACH_FLAG_CODES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading sessions…
          </div>
        ) : sessions.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No Wrong Answer Coach sessions match the current filters.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2.5">
            {sessions.map((row) => (
              <Card
                key={row.id}
                className={
                  row.hasUrgentSupport ? "border-destructive" : undefined
                }
              >
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">
                        {row.studentName}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {row.className} • {row.quizName} • Q{row.questionNumber}
                      </span>
                      {row.diagnosis && (
                        <Badge variant="outline">
                          {row.diagnosis}
                          {row.diagnosisMisconceptionCode
                            ? ` (${row.diagnosisMisconceptionCode})`
                            : ""}
                        </Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>
                        Started{" "}
                        {new Date(row.startedAt).toLocaleString([], {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </span>
                      <span>• State: {row.state}</span>
                      {row.check2TopVoteCount !== null && (
                        <span>• Check 2 votes: {row.check2TopVoteCount}/5</span>
                      )}
                      {row.check3IsCorrect !== null && (
                        <span>
                          • Check 3:{" "}
                          {row.check3IsCorrect ? "Correct" : "Incorrect"}
                        </span>
                      )}
                      {row.heldOutIsCorrect !== null && (
                        <span>
                          • Held-out:{" "}
                          {row.heldOutIsCorrect ? "Correct" : "Incorrect"}
                        </span>
                      )}
                    </div>

                    {row.flags.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {row.flags.map((f) => (
                          <Badge
                            key={f}
                            variant={
                              f === "PERSONAL_SUPPORT_NEEDED"
                                ? "destructive"
                                : "secondary"
                            }
                            className="text-[11px]"
                          >
                            {f}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSelectedId(row.id)}
                  >
                    View details
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <CoachReviewDetailDrawer
          sessionId={selectedId}
          apiBasePath={apiBasePath}
          onClose={() => setSelectedId(null)}
        />
      </div>
    </div>
  );
}
