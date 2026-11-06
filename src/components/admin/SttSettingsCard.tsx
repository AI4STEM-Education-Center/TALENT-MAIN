"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Mic,
  RefreshCw,
  Save,
  Search,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  SttLanguageCode,
  SttPartialStability,
  SttSettings,
} from "@/lib/stt/types";

interface LanguageItem {
  code: SttLanguageCode;
  label: string;
}

interface UserUsageSummary {
  userId: string;
  userName: string;
  userEmail: string;
  role: string;
  sessions: number;
  totalDurationMs: number;
  lastUsedAt: string;
}

interface SttUsageLogRow {
  id: string;
  createdAt: string;
  userId: string | null;
  userName: string;
  userEmail: string;
  role: string;
  durationMs: number;
  surface: string;
  languageCode: string;
}

interface AdminSttPayload {
  settings: SttSettings;
  defaultRegion: string;
  catalogs: {
    languages: LanguageItem[];
    regions: string[];
    stabilities: SttPartialStability[];
    surfaces: string[];
  };
  usage: {
    totalSessions: number;
    totalDurationMs: number;
    uniqueUsers: number;
    userSummaries: UserUsageSummary[];
    logs: SttUsageLogRow[];
    page: number;
    pageSize: number;
  };
}

const SURFACE_LABELS: Record<string, string> = {
  student_assistant: "Student assistant",
  teacher_assistant: "Teacher assistant",
  wrong_answer_coach: "Wrong-answer coach",
  simulation_editor: "Simulation editing chat",
};

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 100) / 10);
  if (totalSec < 60) {
    return `${totalSec.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSec / 60);
  const seconds = Math.round(totalSec % 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m ${seconds}s`;
}

export function SttSettingsCard() {
  const [payload, setPayload] = useState<AdminSttPayload | null>(null);
  const [draft, setDraft] = useState<SttSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [usageTab, setUsageTab] = useState<"users" | "sessions">("users");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (keepDraft = false) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page) });
        if (query) params.set("q", query);
        const res = await fetch(`/api/admin/stt?${params}`);
        if (!res.ok) throw new Error("Failed to load STT settings");
        const data = (await res.json()) as AdminSttPayload;
        setPayload(data);
        if (!keepDraft) {
          setDraft(data.settings);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load STT settings",
        );
      } finally {
        setLoading(false);
      }
    },
    [page, query],
  );

  useEffect(() => {
    void load(draft !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const updateDraft = (patch: Partial<SttSettings>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setStatus(null);
  };

  const toggleLanguageOption = (code: SttLanguageCode) => {
    if (!draft) return;
    const exists = draft.languageOptions.includes(code);
    const next = exists
      ? draft.languageOptions.filter((c) => c !== code)
      : [...draft.languageOptions, code];
    // Keep at least 2 options when automatic language identification is enabled
    if (draft.identifyLanguage && next.length < 2) return;
    updateDraft({ languageOptions: next });
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/stt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to save STT settings");
      }
      const { settings } = (await res.json()) as { settings: SttSettings };
      setDraft(settings);
      setStatus("Saved");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save STT settings",
      );
    } finally {
      setSaving(false);
    }
  };

  if (!payload || !draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" /> Loading speech-to-text
        settings…
      </div>
    );
  }

  const { catalogs, usage, defaultRegion } = payload;
  const totalPages = Math.max(
    1,
    Math.ceil(usage.totalSessions / usage.pageSize),
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mic className="size-4 text-primary" />
            Speech-to-Text (Amazon Transcribe Streaming)
          </CardTitle>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={draft.enabled}
              onChange={(event) =>
                updateDraft({ enabled: event.target.checked })
              }
            />
            {draft.enabled ? "Enabled" : "Disabled"}
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Real-time voice input in the student assistant, teacher assistant,
          wrong-answer coach, and simulation editing chat. Audio streams directly
          from the user&apos;s browser to Amazon Transcribe Streaming over a
          short-lived SigV4-presigned WebSocket — zero audio or ML inference runs
          on this server.
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Configuration controls */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label
              id="stt-language-label"
              htmlFor="stt-language-select"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              {draft.identifyLanguage
                ? "Preferred primary language"
                : "Transcription language"}
            </label>
            <Select
              aria-labelledby="stt-language-label"
              value={draft.languageCode}
              onValueChange={(value) =>
                updateDraft({ languageCode: value as SttLanguageCode })
              }
            >
              <SelectTrigger id="stt-language-select" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {catalogs.languages.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label
              id="stt-region-label"
              htmlFor="stt-region-select"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              AWS Transcribe Region
            </label>
            <Select
              aria-labelledby="stt-region-label"
              value={draft.region || "default"}
              onValueChange={(value) =>
                updateDraft({ region: value === "default" ? "" : value })
              }
            >
              <SelectTrigger id="stt-region-select" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  Deployment default ({defaultRegion})
                </SelectItem>
                {catalogs.regions.map((region) => (
                  <SelectItem key={region} value={region}>
                    {region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label
              id="stt-stability-label"
              htmlFor="stt-stability-select"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Partial-result stability
            </label>
            <Select
              aria-labelledby="stt-stability-label"
              value={
                draft.enablePartialResultsStabilization
                  ? draft.partialResultsStability
                  : "off"
              }
              onValueChange={(value) => {
                if (value === "off") {
                  updateDraft({ enablePartialResultsStabilization: false });
                } else {
                  updateDraft({
                    enablePartialResultsStabilization: true,
                    partialResultsStability: value as SttPartialStability,
                  });
                }
              }}
            >
              <SelectTrigger id="stt-stability-select" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">
                  High (fewer partial revisions)
                </SelectItem>
                <SelectItem value="medium">
                  Medium (recommended balance)
                </SelectItem>
                <SelectItem value="low">Low (fastest partial words)</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Automatic language identification */}
        <div className="rounded-md border border-border p-3 space-y-2">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={draft.identifyLanguage}
              onChange={(event) =>
                updateDraft({ identifyLanguage: event.target.checked })
              }
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                Automatic language identification
              </span>
              <span className="block text-xs text-muted-foreground">
                Automatically detect which language the speaker is using from the
                candidate languages below (e.g. English and Mandarin Chinese).
              </span>
            </span>
          </label>

          {draft.identifyLanguage && (
            <div className="pt-2 pl-6">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Candidate languages (select at least 2):
              </p>
              <div className="flex flex-wrap gap-2">
                {catalogs.languages.map((lang) => {
                  const selected = draft.languageOptions.includes(lang.code);
                  return (
                    <label
                      key={lang.code}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                        selected
                          ? "border-primary bg-primary/5 font-medium"
                          : "border-border text-muted-foreground",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-primary"
                        checked={selected}
                        onChange={() => toggleLanguageOption(lang.code)}
                      />
                      {lang.label}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save STT Settings
          </Button>
          {status && (
            <span className="text-xs text-muted-foreground">{status}</span>
          )}
        </div>

        {/* ─── STT Usage Log (Who used voice input & for how long) ────────── */}
        <div className="border-t border-border pt-5 space-y-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Clock className="size-4 text-primary" />
                Voice Input Usage Log
              </h4>
              <p className="text-xs text-muted-foreground">
                Who used speech-to-text, on which assistant surface, and for how
                long.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void load(true)}
                disabled={loading}
              >
                <RefreshCw
                  className={cn("mr-1.5 size-3.5", loading && "animate-spin")}
                />
                Refresh
              </Button>
            </div>
          </div>

          {/* Summary KPI cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">Total Duration</p>
              <p className="text-lg font-bold tabular-nums">
                {formatDuration(usage.totalDurationMs)}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">Total Sessions</p>
              <p className="text-lg font-bold tabular-nums">
                {usage.totalSessions}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">Unique Users</p>
              <p className="text-lg font-bold tabular-nums">
                {usage.uniqueUsers}
              </p>
            </div>
          </div>

          {/* Filter & View Switcher */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div
              className="flex gap-1.5"
              role="group"
              aria-label="STT usage view"
            >
              <button
                type="button"
                aria-pressed={usageTab === "users"}
                onClick={() => setUsageTab("users")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                  usageTab === "users"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background hover:bg-accent",
                )}
              >
                <Users className="size-3.5" />
                By User ({usage.userSummaries.length})
              </button>
              <button
                type="button"
                aria-pressed={usageTab === "sessions"}
                onClick={() => setUsageTab("sessions")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                  usageTab === "sessions"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background hover:bg-accent",
                )}
              >
                <Clock className="size-3.5" />
                Session Log ({usage.totalSessions})
              </button>
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filter by user, email, or role…"
                className="h-8 pl-8 text-xs"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </div>
          </div>

          {usageTab === "users" ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-muted/50 uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">User</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Sessions</th>
                    <th className="px-3 py-2 font-medium">Total Duration</th>
                    <th className="px-3 py-2 font-medium">Last Used</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {usage.userSummaries.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-4 py-6 text-center text-muted-foreground"
                      >
                        No voice input sessions recorded yet.
                      </td>
                    </tr>
                  ) : (
                    usage.userSummaries.map((u) => (
                      <tr key={u.userId} className="hover:bg-muted/30">
                        <td className="px-3 py-2">
                          <span className="block font-medium text-foreground">
                            {u.userName}
                          </span>
                          <span className="block text-muted-foreground">
                            {u.userEmail}
                          </span>
                        </td>
                        <td className="px-3 py-2">{u.role}</td>
                        <td className="px-3 py-2 tabular-nums">{u.sessions}</td>
                        <td className="px-3 py-2 font-medium tabular-nums">
                          {formatDuration(u.totalDurationMs)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                          {/* react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- client-only admin fetch */}
                          {new Date(u.lastUsedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border bg-muted/50 uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Time</th>
                      <th className="px-3 py-2 font-medium">User</th>
                      <th className="px-3 py-2 font-medium">Role</th>
                      <th className="px-3 py-2 font-medium">Surface</th>
                      <th className="px-3 py-2 font-medium">Language</th>
                      <th className="px-3 py-2 font-medium">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {usage.logs.length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-4 py-6 text-center text-muted-foreground"
                        >
                          No voice input sessions match the current filter.
                        </td>
                      </tr>
                    ) : (
                      usage.logs.map((row) => (
                        <tr key={row.id} className="hover:bg-muted/30">
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                            {/* react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- client-only admin fetch */}
                            {new Date(row.createdAt).toLocaleString()}
                          </td>
                          <td className="px-3 py-2">
                            <span className="block font-medium text-foreground">
                              {row.userName}
                            </span>
                            <span className="block text-muted-foreground">
                              {row.userEmail}
                            </span>
                          </td>
                          <td className="px-3 py-2">{row.role}</td>
                          <td className="px-3 py-2">
                            {SURFACE_LABELS[row.surface] ?? row.surface}
                          </td>
                          <td className="px-3 py-2 font-mono">
                            {row.languageCode}
                          </td>
                          <td className="px-3 py-2 font-medium tabular-nums">
                            {formatDuration(row.durationMs)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {usage.totalSessions > usage.pageSize && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    Page {usage.page} of {totalPages}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1 || loading}
                    >
                      <ChevronLeft className="size-3.5" /> Previous
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setPage((p) => Math.min(totalPages, p + 1))
                      }
                      disabled={page >= totalPages || loading}
                    >
                      Next <ChevronRight className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
