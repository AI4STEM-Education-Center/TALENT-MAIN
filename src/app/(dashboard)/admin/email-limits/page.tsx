"use client";
import { useCallback, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Gauge, Loader2, Check, AlertTriangle } from "lucide-react";

interface QuotaResult {
  dailyLimit: number;
  dailyUsed: number;
  monthlyLimit: number;
  monthlyUsed: number;
}

interface TeacherRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  emailDailyLimit: number | null;
  emailMonthlyLimit: number | null;
  quota: QuotaResult;
}

interface Defaults {
  emailDailyLimit: number;
  emailMonthlyLimit: number;
}

type Draft = { daily: string; monthly: string };

export default function AdminEmailLimitsPage() {
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [defaults, setDefaults] = useState<Defaults>({ emailDailyLimit: 0, emailMonthlyLimit: 0 });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/teachers");
      if (res.ok) {
        const data = await res.json();
        const rows: TeacherRow[] = data.teachers ?? [];
        setTeachers(rows);
        setDefaults(data.defaults);
        setDrafts(
          Object.fromEntries(
            rows.map((t) => [
              t.id,
              {
                daily: t.emailDailyLimit?.toString() ?? "",
                monthly: t.emailMonthlyLimit?.toString() ?? "",
              },
            ])
          )
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setDraft(id: string, field: keyof Draft, value: string) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  }

  async function handleSave(id: string) {
    setBanner(null);
    setSavingId(id);
    const draft = drafts[id];
    try {
      const res = await fetch(`/api/admin/teachers/${id}/email-limit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailDailyLimit: draft.daily.trim() === "" ? null : Number(draft.daily),
          emailMonthlyLimit: draft.monthly.trim() === "" ? null : Number(draft.monthly),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", text: data.error || "Failed to save limits." });
      } else {
        setBanner({ type: "success", text: "Limits saved." });
        await load();
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      setSavingId(null);
    }
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[300px]">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Gauge className="size-7" /> Email Limits
        </h1>
        <p className="text-muted-foreground mt-1">
          Per-teacher email sending caps, counted per recipient. Leave a field blank to use the default
          ({defaults.emailDailyLimit}/day, {defaults.emailMonthlyLimit}/month). In-app notifications are unlimited.
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

      <div className="border border-border rounded-lg bg-card overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border">
            <tr>
              <th className="px-4 py-3 font-medium">Teacher</th>
              <th className="px-4 py-3 font-medium">Used today</th>
              <th className="px-4 py-3 font-medium">Used this month</th>
              <th className="px-4 py-3 font-medium">Daily limit</th>
              <th className="px-4 py-3 font-medium">Monthly limit</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {teachers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No teachers yet.
                </td>
              </tr>
            ) : (
              teachers.map((t) => {
                const draft = drafts[t.id] ?? { daily: "", monthly: "" };
                return (
                  <tr key={t.id} className="hover:bg-muted/40 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <span className="font-medium text-foreground">
                          {t.firstName} {t.lastName}
                        </span>
                        <span className="text-xs text-muted-foreground">{t.email}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {t.quota.dailyUsed} / {t.quota.dailyLimit}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {t.quota.monthlyUsed} / {t.quota.monthlyLimit}
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        min={1}
                        value={draft.daily}
                        onChange={(e) => setDraft(t.id, "daily", e.target.value)}
                        placeholder={`${defaults.emailDailyLimit} (default)`}
                        className="w-32"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        min={1}
                        value={draft.monthly}
                        onChange={(e) => setDraft(t.id, "monthly", e.target.value)}
                        placeholder={`${defaults.emailMonthlyLimit} (default)`}
                        className="w-32"
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="outline" onClick={() => handleSave(t.id)} disabled={savingId === t.id}>
                        {savingId === t.id ? <Loader2 className="size-4 animate-spin" /> : "Save"}
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
