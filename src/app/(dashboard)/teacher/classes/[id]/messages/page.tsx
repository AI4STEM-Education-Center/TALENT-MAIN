"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Bell,
  Mail,
  Send,
  Loader2,
  CheckCircle,
  AlertTriangle,
  MessageSquare,
  Users,
} from "lucide-react";

interface QuotaResult {
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  monthlyLimit: number;
  monthlyUsed: number;
  monthlyRemaining: number;
  remaining: number;
}

interface MessageRow {
  id: string;
  subject: string;
  body: string;
  channels: string;
  recipientCount: number;
  sentCount: number;
  inAppCount: number;
  status: string;
  error: string | null;
  createdAt: string;
}

interface PageData {
  className: string;
  enrolledCount: number;
  emailableCount: number;
  quota: QuotaResult | null;
  messages: MessageRow[];
  loading: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ClassMessagesPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<PageData>({
    className: "",
    enrolledCount: 0,
    emailableCount: 0,
    quota: null,
    messages: [],
    loading: true,
  });
  const [form, setForm] = useState({ subject: "", body: "", inApp: true, email: false });
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const [clsRes, studentsRes, quotaRes, msgsRes] = await Promise.all([
      fetch(`/api/classes/${id}`),
      fetch(`/api/classes/${id}/students`),
      fetch(`/api/teacher/email-quota`),
      fetch(`/api/classes/${id}/messages`),
    ]);
    const cls = clsRes.ok ? await clsRes.json() : {};
    const students = studentsRes.ok ? await studentsRes.json() : [];
    const quota = quotaRes.ok ? await quotaRes.json() : null;
    const messages = msgsRes.ok ? await msgsRes.json() : [];
    setData({
      className: cls.name || "",
      enrolledCount: Array.isArray(students) ? students.filter((s: { isEnrolled: boolean }) => s.isEnrolled).length : 0,
      emailableCount: Array.isArray(students)
        ? students.filter((s: { email: string }) => !!s.email && EMAIL_RE.test(s.email)).length
        : 0,
      quota,
      messages: Array.isArray(messages) ? messages : [],
      loading: false,
    });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const remaining = data.quota?.remaining ?? 0;
  const emailOverBudget = form.email && data.emailableCount > remaining;
  const canSend =
    !!form.subject.trim() &&
    !!form.body.trim() &&
    (form.inApp || form.email) &&
    !emailOverBudget &&
    !(form.email && data.emailableCount === 0) &&
    !(form.inApp && !form.email && data.enrolledCount === 0);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    setSending(true);
    try {
      const res = await fetch(`/api/classes/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: form.subject,
          body: form.body,
          channels: { inApp: form.inApp, email: form.email },
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", text: result.error || "Failed to send message." });
      } else {
        const parts: string[] = [];
        if (result.inApp?.count > 0) parts.push(`notified ${result.inApp.count} student${result.inApp.count === 1 ? "" : "s"} in-app`);
        if (result.email) {
          parts.push(
            result.email.status === "FAILED"
              ? `email failed (${result.email.error || "unknown error"})`
              : `emailed ${result.email.sent} student${result.email.sent === 1 ? "" : "s"}`
          );
        }
        setBanner({ type: "success", text: `Message sent — ${parts.join("; ")}.` });
        setForm((p) => ({ ...p, subject: "", body: "" }));
        load();
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      setSending(false);
    }
  }

  if (data.loading) {
    return (
      <div className="p-4 md:p-6 flex items-center justify-center min-h-[300px]">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-3xl">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/teacher/classes/${id}`}>
          <ArrowLeft className="size-4" /> Back to {data.className || "class"}
        </Link>
      </Button>

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MessageSquare className="size-6" /> Messages
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Send an in-app notification, an email, or both to {data.className || "this class"}.
        </p>
      </div>

      {data.quota && (
        <div className="text-sm rounded-md border bg-muted/30 p-3 flex items-start gap-2">
          <Mail className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
          <span>
            <strong>Email budget:</strong> {data.quota.dailyRemaining} left today (of {data.quota.dailyLimit}) ·{" "}
            {data.quota.monthlyRemaining} left this month (of {data.quota.monthlyLimit}). In-app notifications are
            unlimited.
          </span>
        </div>
      )}

      {banner && (
        <div
          className={`p-3 rounded-md text-sm flex items-start gap-2 ${
            banner.type === "success"
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {banner.type === "success" ? (
            <CheckCircle className="size-4 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compose</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSend} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                value={form.subject}
                onChange={(e) => setForm((p) => ({ ...p, subject: e.target.value }))}
                required
                placeholder="e.g. Reminder: Quiz 3 due Friday"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="body">Message</Label>
              <Textarea
                id="body"
                value={form.body}
                onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
                required
                rows={6}
                placeholder="Write your message to the class..."
              />
            </div>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium mb-1">Send via</legend>

              <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="size-4 mt-0.5"
                  checked={form.inApp}
                  onChange={(e) => setForm((p) => ({ ...p, inApp: e.target.checked }))}
                />
                <span className="text-sm">
                  <span className="font-medium flex items-center gap-1.5">
                    <Bell className="size-4" /> In-app notification
                  </span>
                  <span className="text-muted-foreground block mt-0.5">
                    Posts to the notification mailbox of all {data.enrolledCount} enrolled student
                    {data.enrolledCount === 1 ? "" : "s"}. Free and unlimited.
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="size-4 mt-0.5"
                  checked={form.email}
                  disabled={data.emailableCount === 0}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.checked }))}
                />
                <span className="text-sm">
                  <span className="font-medium flex items-center gap-1.5">
                    <Mail className="size-4" /> Email
                  </span>
                  <span className="text-muted-foreground block mt-0.5">
                    {data.emailableCount === 0
                      ? "No roster students have a valid email address."
                      : `Emails ${data.emailableCount} student${data.emailableCount === 1 ? "" : "s"} with a valid email address. Counts against your email budget (${remaining} left).`}
                  </span>
                </span>
              </label>

              {emailOverBudget && (
                <p className="text-xs text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="size-3.5" />
                  Emailing {data.emailableCount} students exceeds your remaining budget of {remaining}. Uncheck Email or
                  wait for the limit to reset.
                </p>
              )}
            </fieldset>

            <Button type="submit" disabled={sending || !canSend}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {sending ? "Sending..." : "Send message"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="size-4" /> Recent messages
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.messages.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No messages sent yet.</p>
          ) : (
            <div className="divide-y">
              {data.messages.map((m) => (
                <div key={m.id} className="py-3 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{m.subject}</span>
                    {m.channels.includes("IN_APP") && (
                      <Badge variant="secondary" className="text-[10px]">
                        <Bell className="size-3 mr-1" /> {m.inAppCount} in-app
                      </Badge>
                    )}
                    {m.channels.includes("EMAIL") && (
                      <Badge
                        variant={m.status === "FAILED" ? "destructive" : m.status === "PARTIAL" ? "outline" : "success"}
                        className="text-[10px]"
                      >
                        <Mail className="size-3 mr-1" /> {m.sentCount}/{m.recipientCount} email
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{m.body}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(m.createdAt).toLocaleString()}
                    {m.error ? ` · ${m.error}` : ""}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
