"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { DISPLAY_LOCALE, formatDateTime } from "@/lib/format-date";
import {
  AlertTriangle,
  Ban,
  Check,
  Copy,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  MAX_EXPIRES_IN_MINUTES,
  MAX_LABEL_LENGTH,
  MAX_USES_LIMIT,
  MIN_EXPIRES_IN_MINUTES,
  TEACHER_CODE_STATUS_LABELS,
  type TeacherCodeStatus,
  type TeacherCodeView,
} from "@/lib/teacher-codes";

/** Duration units the issuer offers, with the multiplier into minutes. */
const UNITS = [
  { value: "minutes", label: "minutes", minutes: 1 },
  { value: "hours", label: "hours", minutes: 60 },
  { value: "days", label: "days", minutes: 60 * 24 },
] as const;

type UnitValue = (typeof UNITS)[number]["value"];

const STATUS_VARIANT: Record<TeacherCodeStatus, "success" | "warning" | "secondary"> = {
  ACTIVE: "success",
  EXPIRED: "warning",
  EXHAUSTED: "warning",
  REVOKED: "secondary",
};

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
];

// Built once at module scope rather than per call. The locale is pinned for the
// same reason as `formatDate`: an undefined locale resolves to the runtime's, so
// the server and the browser can format the same instant differently.
const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat(DISPLAY_LOCALE, { numeric: "auto" });

/** "in 3 days" / "5 hours ago" — enough for an admin to judge a code at a glance. */
function relativeTime(iso: string): string {
  const deltaMs = new Date(iso).getTime() - Date.now();
  let chosen = RELATIVE_UNITS[0];
  for (const unit of RELATIVE_UNITS) {
    if (Math.abs(deltaMs) >= unit[1]) chosen = unit;
  }
  return RELATIVE_FORMATTER.format(Math.round(deltaMs / chosen[1]), chosen[0]);
}

function absoluteTime(iso: string): string {
  return formatDateTime(iso);
}

export function TeacherCodesClient() {
  const confirm = useConfirm();
  const [codes, setCodes] = useState<TeacherCodeView[]>([]);
  const [envTokenActive, setEnvTokenActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const createInFlight = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState<UnitValue>("days");
  const [maxUses, setMaxUses] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/teacher-codes");
      if (!res.ok) {
        // Status before body; the error payload is read only in this branch.
        const errorBody = await res.json().catch(() => null);
        setError(errorBody?.error || "Could not load registration codes.");
        return;
      }
      const data = await res.json();
      setCodes(data.codes);
      setEnvTokenActive(data.envTokenActive);
      setError("");
    } catch {
      setError("Could not load registration codes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unitMinutes = UNITS.find((u) => u.value === unit)?.minutes ?? 1;
  const expiresInMinutes = amount.trim() ? Math.round(Number(amount) * unitMinutes) : null;

  // Validate before sending so the form explains itself instead of relaying a
  // 400. The API enforces the same bounds — this is convenience, not the guard.
  const durationError = useMemo(() => {
    if (expiresInMinutes === null) return "";
    if (!Number.isFinite(expiresInMinutes) || expiresInMinutes < MIN_EXPIRES_IN_MINUTES) {
      return `A code has to last at least ${MIN_EXPIRES_IN_MINUTES} minutes.`;
    }
    if (expiresInMinutes > MAX_EXPIRES_IN_MINUTES) return "That is longer than 5 years.";
    return "";
  }, [expiresInMinutes]);

  const usesError = useMemo(() => {
    if (!maxUses.trim()) return "";
    const parsed = Number(maxUses);
    if (!Number.isInteger(parsed) || parsed < 1) return "The use limit must be a whole number.";
    if (parsed > MAX_USES_LIMIT) return `The use limit tops out at ${MAX_USES_LIMIT}.`;
    return "";
  }, [maxUses]);

  async function createCode(event: React.FormEvent) {
    event.preventDefault();
    if (durationError || usesError) return;
    // `creating` is state and does not disable the submit button until the next
    // render, so a double submit would mint two codes.
    if (createInFlight.current) return;
    createInFlight.current = true;

    setCreating(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/admin/teacher-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: label.trim() || null,
          expiresInMinutes,
          maxUses: maxUses.trim() ? Number(maxUses) : null,
        }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        setError(errorBody?.error || "Could not create the code.");
        return;
      }
      const data = await res.json();
      setCodes((prev) => [data, ...prev]);
      setNotice(`Code ${data.code} created — copy it now and share it with the teacher.`);
      setLabel("");
      setAmount("");
      setMaxUses("");
    } catch {
      setError("Could not create the code.");
    } finally {
      createInFlight.current = false;
      setCreating(false);
    }
  }

  async function setActive(code: TeacherCodeView, active: boolean) {
    if (!active) {
      const ok = await confirm({
        title: "Revoke this code?",
        description:
          "Nobody will be able to register with it from now on. Teachers who already " +
          "signed up keep their accounts, and you can switch the code back on later.",
        confirmText: "Revoke",
        variant: "destructive",
      });
      if (!ok) return;
    }

    setError("");
    setNotice("");
    const res = await fetch(`/api/admin/teacher-codes/${code.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      setError(errorBody?.error || "Could not update the code.");
      return;
    }
    const data = await res.json();
    setCodes((prev) => prev.map((c) => (c.id === data.id ? data : c)));
  }

  async function deleteCode(code: TeacherCodeView) {
    const ok = await confirm({
      title: "Delete this code?",
      description:
        "The code and its usage record disappear from this list for good. " +
        "Revoke instead if you want to keep the record of who it was issued for.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;

    setError("");
    setNotice("");
    const res = await fetch(`/api/admin/teacher-codes/${code.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Could not delete the code.");
      return;
    }
    setCodes((prev) => prev.filter((c) => c.id !== code.id));
  }

  async function copy(value: string, key: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000);
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <KeyRound className="size-6" /> Teacher Codes
          </h1>
          <p className="text-muted-foreground mt-1">
            Registration codes teachers redeem at <code className="text-xs">/register</code>. Each
            one carries its own expiry and use limit, and can be revoked on its own.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} /> Refresh
        </Button>
      </div>

      {envTokenActive && (
        <div className="flex items-start gap-3 p-4 rounded-lg border border-yellow-400/30 bg-yellow-500/10 text-sm">
          <AlertTriangle className="size-4 mt-0.5 shrink-0 text-yellow-600 dark:text-yellow-500" />
          <span>
            <strong>TEACHER_SIGNUP_TOKEN is still set.</strong> That single environment value
            registers teachers no matter what you revoke here, and it never expires. Clear it from
            the deployment&apos;s environment once you have issued the codes you need below.
          </span>
        </div>
      )}

      {error && <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>}
      {notice && <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{notice}</div>}

      <Card>
        <CardHeader>
          <CardTitle>Issue a new code</CardTitle>
          <CardDescription>
            Leave a field empty for no limit: no duration means the code never expires, no use limit
            means it registers any number of teachers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={createCode} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="code-label">Label (optional)</Label>
                <Input
                  id="code-label"
                  value={label}
                  maxLength={MAX_LABEL_LENGTH}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Fall 2026 physics TAs"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="code-duration">Valid for</Label>
                <div className="flex gap-2">
                  <Input
                    id="code-duration"
                    type="number"
                    min="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Never"
                  />
                  <Select value={unit} onValueChange={(v) => setUnit(v as UnitValue)}>
                    <SelectTrigger className="w-32" aria-label="Duration unit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {UNITS.map((u) => (
                        <SelectItem key={u.value} value={u.value}>
                          {u.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {durationError && <p className="text-xs text-destructive">{durationError}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="code-uses">Use limit</Label>
                <Input
                  id="code-uses"
                  type="number"
                  min="1"
                  max={MAX_USES_LIMIT}
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                  placeholder="Unlimited"
                />
                {usesError && <p className="text-xs text-destructive">{usesError}</p>}
              </div>
            </div>
            <Button type="submit" disabled={creating || !!durationError || !!usesError}>
              <Plus className="size-4" /> {creating ? "Generating…" : "Generate code"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Issued codes</CardTitle>
          <CardDescription>
            Share either the code itself or the link, which pre-fills it on the registration form.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && codes.length === 0 && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {!loading && codes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No codes yet. Teachers cannot register until you issue one
              {envTokenActive ? " (or use the environment token above)" : ""}.
            </p>
          )}

          {codes.map((code) => (
            <div key={code.id} className="p-3 rounded-lg border space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-sm bg-muted px-2 py-1 rounded font-mono tracking-wider">
                  {code.code}
                </code>
                <Badge
                  variant={STATUS_VARIANT[code.status]}
                  title={TEACHER_CODE_STATUS_LABELS[code.status]}
                >
                  {code.status}
                </Badge>
                {code.label && <span className="text-sm text-muted-foreground">{code.label}</span>}
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void copy(code.code, `c-${code.id}`)}>
                    {copied === `c-${code.id}` ? <Check className="size-3" /> : <Copy className="size-3" />}
                    Code
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void copy(code.url, `u-${code.id}`)}>
                    {copied === `u-${code.id}` ? <Check className="size-3" /> : <Link2 className="size-3" />}
                    Link
                  </Button>
                  {code.active ? (
                    <Button size="sm" variant="outline" onClick={() => void setActive(code, false)}>
                      <Ban className="size-3" /> Revoke
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => void setActive(code, true)}>
                      <RotateCcw className="size-3" /> Restore
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    aria-label="Delete code"
                    onClick={() => void deleteCode(code)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {code.usedCount}
                  {code.maxUses ? ` / ${code.maxUses}` : ""} uses
                  {code.maxUses ? "" : " (unlimited)"}
                </span>
                <span title={code.expiresAt ? absoluteTime(code.expiresAt) : undefined}>
                  {code.expiresAt
                    ? `${code.status === "EXPIRED" ? "Expired" : "Expires"} ${relativeTime(code.expiresAt)}`
                    : "Never expires"}
                </span>
                <span title={absoluteTime(code.createdAt)}>Created {relativeTime(code.createdAt)}</span>
                {code.lastUsedAt && (
                  <span title={absoluteTime(code.lastUsedAt)}>
                    Last used {relativeTime(code.lastUsedAt)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
