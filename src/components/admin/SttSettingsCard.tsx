"use client";

import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Mic,
  RefreshCw,
  Search,
  Users,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AWS_TRANSCRIBE_STREAMING_REGIONS,
  STT_LANGUAGES,
  STT_PARTIAL_STABILITIES,
  type SttAdminPayload,
  type SttAdminSettingsPayload,
  type SttLanguageCode,
  type SttPartialStability,
  type SttSettings,
} from "@/lib/stt/types";

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function formatIsoTimestamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 19) + " UTC";
}

const SURFACE_LABELS: Record<string, string> = {
  student_assistant: "Student Chat",
  teacher_assistant: "Teacher Chat",
  wrong_answer_coach: "Wrong-Answer Coach",
  simulation_editor: "Simulation Editor",
};

function SttConfigSection({
  settings,
  effectiveRegion,
  hasCredentials,
  saving,
  savedOk,
  error,
  onPatch,
  onToggleLanguageOption,
  onSave,
}: {
  settings: SttSettings;
  effectiveRegion: string;
  hasCredentials: boolean;
  saving: boolean;
  savedOk: boolean;
  error: string | null;
  onPatch: (patch: Partial<SttSettings>) => void;
  onToggleLanguageOption: (lang: SttLanguageCode) => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-4">
      {!hasCredentials && (
        <div
          role="alert"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
        >
          AWS credentials (<code>AWS_ACCESS_KEY_ID</code> /{" "}
          <code>AWS_SECRET_ACCESS_KEY</code>) were not detected on the server.
          Ensure the application IAM user has{" "}
          <code>transcribe:StartStreamTranscriptionWebSocket</code> permission.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <XCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-muted/20 p-3">
        <div>
          <p className="text-sm font-medium">Enable Speech-to-Text Input</p>
          <p className="text-xs text-muted-foreground">
            Show the microphone button in the Student Assistant, Teacher
            Assistant, Wrong-Answer Coach, and Simulation Editor.
          </p>
        </div>
        <input
          type="checkbox"
          aria-label="Enable Speech-to-Text Input"
          className="size-4 accent-primary"
          checked={settings.enabled}
          onChange={(e) => onPatch({ enabled: e.target.checked })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="stt-language">Primary / Default Language</Label>
          <Select
            value={settings.languageCode}
            onValueChange={(value) => {
              const lang = value as SttLanguageCode;
              const base = lang.split("-")[0].toLowerCase();
              const withoutSameBase = settings.languageOptions.filter(
                (c) => c.split("-")[0].toLowerCase() !== base,
              );
              onPatch({
                languageCode: lang,
                languageOptions: [lang, ...withoutSameBase],
              });
            }}
          >
            <SelectTrigger id="stt-language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STT_LANGUAGES.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  {lang.label} ({lang.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Used when single-language mode is active, or as the preferred
            language during automatic language detection.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="stt-region">AWS Transcribe Region</Label>
          <Select
            value={settings.region || "__env_default__"}
            onValueChange={(value) =>
              onPatch({ region: value === "__env_default__" ? "" : value })
            }
          >
            <SelectTrigger id="stt-region">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__env_default__">
                Default from AWS_REGION ({effectiveRegion})
              </SelectItem>
              {AWS_TRANSCRIBE_STREAMING_REGIONS.map((region) => (
                <SelectItem key={region} value={region}>
                  {region}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Effective region: <code>{settings.region || effectiveRegion}</code>
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="stt-stability">Partial Result Stabilization</Label>
          <Select
            value={
              settings.enablePartialResultsStabilization
                ? settings.partialResultsStability
                : "off"
            }
            onValueChange={(value) => {
              if (value === "off") {
                onPatch({ enablePartialResultsStabilization: false });
              } else {
                onPatch({
                  enablePartialResultsStabilization: true,
                  partialResultsStability: value as SttPartialStability,
                });
              }
            }}
          >
            <SelectTrigger id="stt-stability">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STT_PARTIAL_STABILITIES.map((level) => (
                <SelectItem key={level} value={level}>
                  {level.charAt(0).toUpperCase() + level.slice(1)} stability
                </SelectItem>
              ))}
              <SelectItem value="off">Off (fastest raw partials)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Reduces live text flickering while the user is still speaking.
          </p>
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">
              Automatic Multi-Language Identification (e.g., English + Mandarin
              Chinese)
            </p>
            <p className="text-xs text-muted-foreground">
              Automatically detect which language the speaker is using from the
              selected candidate languages below (primary language is always
              included; one dialect per language).
            </p>
          </div>
          <input
            type="checkbox"
            aria-label="Automatic Multi-Language Identification"
            className="size-4 accent-primary"
            checked={settings.identifyLanguage}
            onChange={(e) => onPatch({ identifyLanguage: e.target.checked })}
          />
        </div>

        {settings.identifyLanguage && (
          <div className="flex flex-wrap gap-2 pt-2">
            {STT_LANGUAGES.map((lang) => {
              const active = (settings.languageOptions ?? []).includes(
                lang.code,
              );
              const isPrimary = lang.code === settings.languageCode;
              return (
                <button
                  key={lang.code}
                  type="button"
                  aria-pressed={active}
                  disabled={isPrimary}
                  title={
                    isPrimary
                      ? "Primary language is always included in automatic identification"
                      : undefined
                  }
                  onClick={() => onToggleLanguageOption(lang.code)}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  } ${isPrimary ? "opacity-80 cursor-default" : ""}`}
                >
                  {lang.label} ({lang.code})
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="mr-1.5 size-4 animate-spin" />
              Saving…
            </>
          ) : (
            "Save STT Settings"
          )}
        </Button>
        {savedOk && (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-4" />
            Settings saved
          </span>
        )}
      </div>
    </div>
  );
}

function SttUsageLogSection({
  usage,
  usageTab,
  userFilter,
  onTabChange,
  onFilterChange,
}: {
  usage: SttAdminPayload["usage"];
  usageTab: "users" | "sessions";
  userFilter: string;
  onTabChange: (tab: "users" | "sessions") => void;
  onFilterChange: (q: string) => void;
}) {
  const filteredUsers = useMemo(() => {
    const q = userFilter.trim().toLowerCase();
    const users = usage.userSummaries ?? [];
    if (!q) return users;
    return users.filter(
      (u) =>
        u.userName.toLowerCase().includes(q) ||
        u.userEmail.toLowerCase().includes(q) ||
        (u.userRole ?? "").toLowerCase().includes(q),
    );
  }, [usage.userSummaries, userFilter]);

  const filteredSessions = useMemo(() => {
    const q = userFilter.trim().toLowerCase();
    const sessions = usage.recentSessions ?? [];
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        (s.userName ?? "").toLowerCase().includes(q) ||
        (s.userEmail ?? "").toLowerCase().includes(q) ||
        s.surface.toLowerCase().includes(q) ||
        s.languageCode.toLowerCase().includes(q),
    );
  }, [usage.recentSessions, userFilter]);

  return (
    <div className="space-y-3 border-t border-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">
            Voice Input Usage Duration Log
          </h3>
          <p className="text-xs text-muted-foreground">
            Tracks who used Speech-to-Text and total audio duration streamed to
            Amazon Transcribe.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md border border-border bg-muted/20 px-3 py-1.5">
            <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3" />
              <span>Total Duration</span>
            </div>
            <p className="text-sm font-semibold">
              {formatDuration(usage.totalDurationMs)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/20 px-3 py-1.5">
            <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
              <Mic className="size-3" />
              <span>Sessions</span>
            </div>
            <p className="text-sm font-semibold">{usage.totalSessions}</p>
          </div>
          <div className="rounded-md border border-border bg-muted/20 px-3 py-1.5">
            <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
              <Users className="size-3" />
              <span>Users</span>
            </div>
            <p className="text-sm font-semibold">{usage.uniqueUsers}</p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Usage log view"
          className="flex gap-1 rounded-md border border-border p-0.5 text-xs"
        >
          <button
            type="button"
            aria-pressed={usageTab === "users"}
            onClick={() => onTabChange("users")}
            className={`rounded px-2.5 py-1 font-medium transition-colors ${
              usageTab === "users"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            By User ({filteredUsers.length})
          </button>
          <button
            type="button"
            aria-pressed={usageTab === "sessions"}
            onClick={() => onTabChange("sessions")}
            className={`rounded px-2.5 py-1 font-medium transition-colors ${
              usageTab === "sessions"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Session Log ({filteredSessions.length})
          </button>
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            aria-label="Filter voice usage log by user, email, or surface"
            value={userFilter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter by user, email, or surface…"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {usageTab === "users" ? (
        <div className="max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted/80 text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Sessions</th>
                <th className="px-3 py-2 font-medium">Total Duration</th>
                <th className="px-3 py-2 font-medium">Last Used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-6 text-center text-muted-foreground"
                  >
                    No voice input usage recorded yet.
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => (
                  <tr key={u.userId} className="hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <div className="font-medium">{u.userName}</div>
                      {u.userEmail && (
                        <div className="text-[11px] text-muted-foreground">
                          {u.userEmail}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">{u.userRole}</td>
                    <td className="px-3 py-2">{u.sessions}</td>
                    <td className="px-3 py-2 font-medium">
                      {formatDuration(u.totalDurationMs)}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatIsoTimestamp(u.lastUsedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted/80 text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Surface</th>
                <th className="px-3 py-2 font-medium">Language</th>
                <th className="px-3 py-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredSessions.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-6 text-center text-muted-foreground"
                  >
                    No voice input sessions recorded yet.
                  </td>
                </tr>
              ) : (
                filteredSessions.map((s) => (
                  <tr key={s.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {formatIsoTimestamp(s.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">
                        {s.userName ?? s.userId ?? "Unknown"}
                      </div>
                      {s.userEmail && (
                        <div className="text-[11px] text-muted-foreground">
                          {s.userEmail}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {SURFACE_LABELS[s.surface] ?? s.surface}
                    </td>
                    <td className="px-3 py-2 font-mono">{s.languageCode}</td>
                    <td className="px-3 py-2 font-medium">
                      {formatDuration(s.durationMs)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SttSettingsCardContent() {
  const [data, setData] = useState<SttAdminPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [userFilter, setUserFilter] = useState("");
  const [usageTab, setUsageTab] = useState<"users" | "sessions">("users");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/stt");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to load STT settings");
      }
      const json = (await res.json()) as SttAdminPayload;
      setData(json);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load STT settings",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateSettings = (patch: Partial<SttSettings>) => {
    setSavedOk(false);
    setData((prev) =>
      prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev,
    );
  };

  const toggleLanguageOption = (lang: SttLanguageCode) => {
    if (!data) return;
    if (lang === data.settings.languageCode) return;
    const current = data.settings.languageOptions ?? [];
    const exists = current.includes(lang);
    if (exists) {
      const next = current.filter((item) => item !== lang);
      if (next.length < 2) return;
      updateSettings({ languageOptions: next });
    } else {
      // Replace any other dialect of the same base language family (e.g. en-US vs en-GB)
      const family = lang.split("-")[0].toLowerCase();
      const filtered = current.filter(
        (item) =>
          item === data.settings.languageCode ||
          item.split("-")[0].toLowerCase() !== family,
      );
      if (
        lang.split("-")[0].toLowerCase() ===
        data.settings.languageCode.split("-")[0].toLowerCase()
      ) {
        return;
      }
      updateSettings({ languageOptions: [...filtered, lang] });
    }
  };

  const handleSave = async () => {
    if (!data) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch("/api/admin/stt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: data.settings }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to save STT settings");
      }
      const updated = (await res.json()) as SttAdminSettingsPayload;
      setData((prev) =>
        prev
          ? {
              ...prev,
              settings: updated.settings,
              effectiveRegion: updated.effectiveRegion,
              hasCredentials: updated.hasCredentials,
            }
          : prev,
      );
      setSavedOk(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save STT settings",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Mic className="size-5 text-primary" />
            Speech-to-Text (Amazon Transcribe Streaming)
          </CardTitle>
          <CardDescription>
            Real-time browser-to-AWS WebSocket voice transcription for chat
            assistants. Audio streams directly from the user&apos;s browser to
            Amazon Transcribe with zero audio buffering on the application
            server.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw
            className={`mr-1.5 size-3.5 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-6">
        {loading && !data ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading Speech-to-Text configuration…
          </div>
        ) : data ? (
          <>
            <SttConfigSection
              settings={data.settings}
              effectiveRegion={data.effectiveRegion}
              hasCredentials={data.hasCredentials}
              saving={saving}
              savedOk={savedOk}
              error={error}
              onPatch={updateSettings}
              onToggleLanguageOption={toggleLanguageOption}
              onSave={() => void handleSave()}
            />
            <SttUsageLogSection
              usage={data.usage}
              usageTab={usageTab}
              userFilter={userFilter}
              onTabChange={setUsageTab}
              onFilterChange={setUserFilter}
            />
          </>
        ) : (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <XCircle className="size-4 shrink-0" />
            <span>{error ?? "Failed to load Speech-to-Text settings."}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Keep a failed STT render local to this section of AI Config.
class SttErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>Speech-to-Text</CardTitle>
          </CardHeader>
          <CardContent>
            <p role="alert">Speech-to-Text settings could not be displayed.</p>
            <Button onClick={() => this.setState({ failed: false })}>
              Retry STT Settings
            </Button>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}

export function SttSettingsCard() {
  return (
    <SttErrorBoundary>
      <SttSettingsCardContent />
    </SttErrorBoundary>
  );
}
