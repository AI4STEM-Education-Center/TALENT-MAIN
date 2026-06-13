"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Check, Loader2, Mail, Save, Send, Server } from "lucide-react";

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  hasPassword: boolean;
  maskedPassword: string | null;
  fromEmail: string;
  fromName: string | null;
  isActive: boolean;
  updatedAt?: string;
}

const EMPTY_FORM = {
  host: "",
  port: 587,
  secure: false,
  username: "",
  password: "",
  fromEmail: "",
  fromName: "",
  isActive: false,
};

export default function AdminEmailPage() {
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [banner, setBanner] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/smtp");
      if (res.ok) {
        const { config } = (await res.json()) as { config: SmtpConfig | null };
        if (config) {
          setForm({
            host: config.host,
            port: config.port,
            secure: config.secure,
            username: config.username ?? "",
            // Show masked placeholder so the saved password is preserved on submit.
            password: config.hasPassword ? "••••••••" : "",
            fromEmail: config.fromEmail,
            fromName: config.fromName ?? "",
            isActive: config.isActive,
          });
          setHasPassword(config.hasPassword);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/smtp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          port: Number(form.port),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", text: data.error || "Failed to save configuration." });
      } else {
        setBanner({ type: "success", text: "SMTP configuration saved." });
        setHasPassword(data.config?.hasPassword ?? hasPassword);
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
      const res = await fetch("/api/admin/smtp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", text: data.error || "SMTP test failed." });
      } else {
        setBanner({ type: "success", text: data.message || "SMTP test succeeded." });
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      setTesting(false);
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
          <Mail className="size-6" /> Email / SMTP Server
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure the outgoing SMTP server used to deliver teacher → student
          notifications and student → teacher messages.
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="size-4" /> Server settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="host">SMTP Host</Label>
                <Input
                  id="host"
                  value={form.host}
                  onChange={(e) => setForm((p) => ({ ...p, host: e.target.value }))}
                  placeholder="smtp.example.com"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port"
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm((p) => ({ ...p, port: Number(e.target.value) }))}
                  placeholder="587"
                  required
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.secure}
                onChange={(e) => setForm((p) => ({ ...p, secure: e.target.checked }))}
                className="size-4"
              />
              Use implicit TLS (SSL) — typically port 465. Leave unchecked for STARTTLS (587).
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  value={form.username}
                  onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
                  placeholder="apikey or user@example.com"
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
                  placeholder={hasPassword ? "•••••••• (unchanged)" : "SMTP password"}
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">
                  Leave the masked value to keep the saved password. Clear the field to remove it.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="fromEmail">From Email</Label>
                <Input
                  id="fromEmail"
                  type="email"
                  value={form.fromEmail}
                  onChange={(e) => setForm((p) => ({ ...p, fromEmail: e.target.value }))}
                  placeholder="no-reply@example.com"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fromName">From Name <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  id="fromName"
                  value={form.fromName}
                  onChange={(e) => setForm((p) => ({ ...p, fromName: e.target.value }))}
                  placeholder="AI4Talent"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm((p) => ({ ...p, isActive: e.target.checked }))}
                className="size-4"
              />
              Enable email sending
            </label>

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
            <Send className="size-4" /> Test connection
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Verifies the saved configuration. Provide an address to also receive a test email.
            Save any changes before testing.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@example.com (optional)"
            />
            <Button type="button" variant="outline" onClick={handleTest} disabled={testing} className="shrink-0">
              {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {testing ? "Testing..." : "Send test"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
