"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle,
  Check,
  Clock,
  Database,
  HardDrive,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Server,
} from "lucide-react";

interface BackupConfig {
  webdavUrl: string | null;
  webdavUsername: string | null;
  hasPassword: boolean;
  maskedPassword: string | null;
  baseDir: string;
  enabled: boolean;
  intervalHours: number;
  anchorTime: string;
  timezone: string;
  keepRecent: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastBackupKey: string | null;
  updatedAt?: string;
}

interface BackupItem {
  name: string;
  date: string;
  size: number;
  includesS3: boolean;
  s3ObjectCount: number | null;
  s3TotalBytes: number | null;
}

const EMPTY_FORM = {
  webdavUrl: "",
  webdavUsername: "",
  password: "",
  baseDir: "/backups",
  enabled: false,
  intervalHours: 24,
  anchorTime: "02:00",
  timezone: "America/New_York",
  keepRecent: 7,
  keepWeekly: 4,
  keepMonthly: 12,
  keepYearly: 3,
};

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}

export default function AdminBackupPage() {
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [hasPassword, setHasPassword] = useState(false);
  const [appEnv, setAppEnv] = useState<string>("dev");
  const [status, setStatus] = useState<Pick<
    BackupConfig,
    "lastRunAt" | "nextRunAt" | "lastStatus" | "lastError" | "lastBackupKey"
  > | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [banner, setBanner] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/backup");
      if (res.ok) {
        const data = (await res.json()) as {
          config: BackupConfig | null;
          appEnv: string;
        };
        setAppEnv(data.appEnv);
        if (data.config) {
          const c = data.config;
          setForm({
            webdavUrl: c.webdavUrl ?? "",
            webdavUsername: c.webdavUsername ?? "",
            password: c.hasPassword ? "••••••••" : "",
            baseDir: c.baseDir,
            enabled: c.enabled,
            intervalHours: c.intervalHours,
            anchorTime: c.anchorTime,
            timezone: c.timezone,
            keepRecent: c.keepRecent,
            keepWeekly: c.keepWeekly,
            keepMonthly: c.keepMonthly,
            keepYearly: c.keepYearly,
          });
          setHasPassword(c.hasPassword);
          setStatus({
            lastRunAt: c.lastRunAt,
            nextRunAt: c.nextRunAt,
            lastStatus: c.lastStatus,
            lastError: c.lastError,
            lastBackupKey: c.lastBackupKey,
          });
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBackups = useCallback(async () => {
    setLoadingBackups(true);
    try {
      const res = await fetch("/api/admin/backup/list");
      if (res.ok) {
        const data = (await res.json()) as { backups: BackupItem[] };
        setBackups(data.backups);
      }
    } finally {
      setLoadingBackups(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!loading) loadBackups();
  }, [loading, loadBackups]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/backup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          intervalHours: Number(form.intervalHours),
          keepRecent: Number(form.keepRecent),
          keepWeekly: Number(form.keepWeekly),
          keepMonthly: Number(form.keepMonthly),
          keepYearly: Number(form.keepYearly),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", text: data.error || "Failed to save configuration." });
      } else {
        setBanner({ type: "success", text: "Backup configuration saved." });
        setHasPassword(data.config?.hasPassword ?? hasPassword);
        await load();
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setBanner(null);
    setTesting(true);
    try {
      const res = await fetch("/api/admin/backup/test", { method: "POST" });
      // Status before body: an HTTP error page has no `success` field, so it
      // would otherwise fall through to the generic "test failed" branch and
      // hide the real status.
      if (!res.ok) {
        setBanner({ type: "error", text: `WebDAV test failed (HTTP ${res.status}).` });
        return;
      }
      const data = await res.json();
      if (data.success) {
        setBanner({ type: "success", text: data.message || "Connected to WebDAV." });
      } else {
        setBanner({ type: "error", text: data.error || "WebDAV test failed." });
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      setTesting(false);
    }
  }

  async function handleRun() {
    setBanner(null);
    setRunning(true);
    try {
      const res = await fetch("/api/admin/backup/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", text: data.error || "Failed to queue backup." });
      } else {
        setBanner({
          type: "success",
          text: "Database and S3 backup queued — it runs in the background. Refresh the list in a moment.",
        });
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      setRunning(false);
    }
  }

  async function handleRestore(name: string) {
    if (
      !window.confirm(
        `Restore "${name}"? Its S3 snapshot (when included) will be restored now, and the current ${appEnv} database will be replaced on the next service restart.`,
      )
    ) {
      return;
    }
    setBanner(null);
    setRestoring(name);
    try {
      const res = await fetch("/api/admin/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", text: data.error || "Failed to stage restore." });
      } else {
        setBanner({ type: "success", text: data.message || "Restore staged. Restart to apply." });
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      setRestoring(null);
    }
  }

  if (loading) {
    return (
      <div className="p-4 md:p-6 flex items-center justify-center min-h-[300px]">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <HardDrive className="size-6" /> Database &amp; S3 Backup
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Snapshots this <strong>{appEnv}</strong> database to WebDAV under{" "}
          <span className="font-mono">{form.baseDir}/{appEnv}</span>. Manual backups also copy the
          deployment&apos;s S3 documents; scheduled backups remain database-only.
        </p>
      </div>

      {banner && (
        <div
          className={`p-3 rounded-md text-sm flex items-start gap-2 ${
            banner.type === "success"
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {banner.type === "success" ? (
            <Check className="size-4 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      {status && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="size-4" /> Status
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>
              Last run:{" "}
              <span className="font-medium">
                {status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : "never"}
              </span>{" "}
              {status.lastStatus && (
                <span
                  className={
                    status.lastStatus === "SUCCESS"
                      ? "text-green-600 dark:text-green-400"
                      : status.lastStatus === "FAILED"
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }
                >
                  ({status.lastStatus})
                </span>
              )}
            </div>
            <div>
              Next run:{" "}
              <span className="font-medium">
                {status.nextRunAt ? new Date(status.nextRunAt).toLocaleString() : "—"}
              </span>
            </div>
            {status.lastError && (
              <div className="text-destructive">Last error: {status.lastError}</div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="size-4" /> WebDAV connection
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="webdavUrl">WebDAV URL</Label>
              <Input
                id="webdavUrl"
                value={form.webdavUrl}
                onChange={(e) => setForm((p) => ({ ...p, webdavUrl: e.target.value }))}
                placeholder="https://dav.example.com/remote.php/dav/files/user"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="webdavUsername">Username</Label>
                <Input
                  id="webdavUsername"
                  value={form.webdavUsername}
                  onChange={(e) => setForm((p) => ({ ...p, webdavUsername: e.target.value }))}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                  placeholder={hasPassword ? "•••••••• (unchanged)" : "WebDAV password"}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="baseDir">Base directory</Label>
              <Input
                id="baseDir"
                value={form.baseDir}
                onChange={(e) => setForm((p) => ({ ...p, baseDir: e.target.value }))}
                placeholder="/backups"
              />
              <p className="text-xs text-muted-foreground">
                Backups are written under <span className="font-mono">{form.baseDir}/prod</span>{" "}
                and <span className="font-mono">{form.baseDir}/dev</span>.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {saving ? "Saving..." : "Save configuration"}
              </Button>
              <Button type="button" variant="outline" onClick={handleTest} disabled={testing}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />}
                {testing ? "Testing..." : "Test connection"}
              </Button>
              <Button type="button" variant="outline" onClick={handleRun} disabled={running}>
                {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {running ? "Queuing..." : "Back up database + S3 now"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" /> Schedule &amp; retention
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))}
                className="size-4"
              />
              Enable scheduled backups
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="intervalHours">Every (hours)</Label>
                <Input
                  id="intervalHours"
                  type="number"
                  min={1}
                  value={form.intervalHours}
                  onChange={(e) => setForm((p) => ({ ...p, intervalHours: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="anchorTime">Anchor time</Label>
                <Input
                  id="anchorTime"
                  type="time"
                  value={form.anchorTime}
                  onChange={(e) => setForm((p) => ({ ...p, anchorTime: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="timezone">Timezone</Label>
                <Input
                  id="timezone"
                  value={form.timezone}
                  onChange={(e) => setForm((p) => ({ ...p, timezone: e.target.value }))}
                  placeholder="America/New_York"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Default is daily at 02:00 America/New_York (handles EST/EDT). Scheduled runs back up
              only the database; S3 is included only when you use the manual button above.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(
                [
                  ["keepRecent", "Keep recent"],
                  ["keepWeekly", "Keep weekly"],
                  ["keepMonthly", "Keep monthly"],
                  ["keepYearly", "Keep yearly"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={key}>{label}</Label>
                  <Input
                    id={key}
                    type="number"
                    min={0}
                    value={form[key]}
                    onChange={(e) => setForm((p) => ({ ...p, [key]: Number(e.target.value) }))}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Grandfather-father-son retention: keep the newest N, plus the newest in each of the
              last N weeks, months, and years.
            </p>

            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {saving ? "Saving..." : "Save configuration"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="size-4" /> Available backups ({appEnv})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button type="button" variant="outline" size="sm" onClick={loadBackups} disabled={loadingBackups}>
            {loadingBackups ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            Refresh
          </Button>
          {backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">No backups found.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {backups.map((b) => (
                <li key={b.name} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{new Date(b.date).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground truncate font-mono">
                      {b.name} · {formatBytes(b.size)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {b.includesS3 && b.s3TotalBytes !== null
                        ? `Database + ${formatBytes(b.s3TotalBytes)} of S3 documents (${b.s3ObjectCount ?? 0} objects)`
                        : "Database only"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => handleRestore(b.name)}
                    disabled={restoring === b.name}
                  >
                    {restoring === b.name ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RotateCcw className="size-4" />
                    )}
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Restore uses this same list for both artifacts: S3 documents are restored immediately
            when present, and the database is staged for the next service restart.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
