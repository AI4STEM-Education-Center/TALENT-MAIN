"use client";
import { useCallback, useEffect, useRef, useState } from "react";
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
  Clock,
  Search,
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

interface EmailTally {
  queued: number;
  sent: number;
  failed: number;
}

interface MessageRow {
  id: string;
  subject: string;
  body: string;
  channels: string;
  recipientCount: number;
  inAppCount: number;
  status: string;
  error: string | null;
  createdAt: string;
  /** Live per-recipient delivery tally; email is delivered by the worker. */
  email: EmailTally;
  /** Formatted at load time (not during render) so SSR and the client agree. */
  sentAtLabel: string;
}

interface RecipientStudent {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface PageData {
  className: string;
  students: RecipientStudent[];
  quota: QuotaResult | null;
  messages: MessageRow[];
  loading: boolean;
}

// While anything is still queued, the worker is actively delivering — refresh
// so the teacher watches the tally settle instead of wondering.
const DELIVERY_POLL_MS = 8_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function RecipientSelector({
  students,
  mode,
  onModeChange,
  selectedUserIds,
  onSelectionChange,
}: {
  students: RecipientStudent[];
  mode: "all" | "selected";
  onModeChange: (mode: "all" | "selected") => void;
  selectedUserIds: string[];
  onSelectionChange: (userIds: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const selectedSet = new Set(selectedUserIds);
  const normalizedSearch = search.trim().toLowerCase();
  const visibleStudents = normalizedSearch
    ? students.filter((student) =>
        `${student.firstName} ${student.lastName} ${student.email}`.toLowerCase().includes(normalizedSearch)
      )
    : students;

  function toggleStudent(userId: string) {
    onSelectionChange(
      selectedSet.has(userId)
        ? selectedUserIds.filter((id) => id !== userId)
        : [...selectedUserIds, userId]
    );
  }

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Recipients</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
          <input
            type="radio"
            name="recipientMode"
            className="mt-0.5 size-4"
            checked={mode === "all"}
            onChange={() => onModeChange("all")}
          />
          <span className="text-sm">
            <span className="block font-medium">Whole class</span>
            <span className="mt-0.5 block text-muted-foreground">
              All {students.length} enrolled student{students.length === 1 ? "" : "s"}
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
          <input
            type="radio"
            name="recipientMode"
            className="mt-0.5 size-4"
            checked={mode === "selected"}
            disabled={students.length === 0}
            onChange={() => onModeChange("selected")}
          />
          <span className="text-sm">
            <span className="block font-medium">Specific students</span>
            <span className="mt-0.5 block text-muted-foreground">Choose one student or a group</span>
          </span>
        </label>
      </div>

      {mode === "selected" && (
        <div className="overflow-hidden rounded-md border">
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 p-2">
            <div className="relative min-w-48 flex-1">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-9 pl-8"
                placeholder="Search students"
                aria-label="Search students"
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onSelectionChange(students.map((student) => student.userId))}
            >
              Select all
            </Button>
            {selectedUserIds.length > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => onSelectionChange([])}>
                Clear
              </Button>
            )}
          </div>
          <div className="max-h-56 divide-y overflow-y-auto">
            {visibleStudents.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">No students match your search.</p>
            ) : (
              visibleStudents.map((student) => (
                <label
                  key={student.userId}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={selectedSet.has(student.userId)}
                    onChange={() => toggleStudent(student.userId)}
                  />
                  <span className="min-w-0 text-sm">
                    <span className="block font-medium">
                      {student.firstName} {student.lastName}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{student.email}</span>
                  </span>
                </label>
              ))
            )}
          </div>
          <p className="border-t bg-muted/20 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
            {selectedUserIds.length} student{selectedUserIds.length === 1 ? "" : "s"} selected
          </p>
        </div>
      )}
    </fieldset>
  );
}

export default function ClassMessagesPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<PageData>({
    className: "",
    students: [],
    quota: null,
    messages: [],
    loading: true,
  });
  const [form, setForm] = useState({ subject: "", body: "" });
  const [recipientMode, setRecipientMode] = useState<"all" | "selected">("all");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const sendLock = useRef(false);
  const [banner, setBanner] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const [msgsRes, quotaRes] = await Promise.all([
      fetch(`/api/classes/${id}/messages`),
      fetch(`/api/teacher/email-quota`),
    ]);
    const payload = msgsRes.ok ? await msgsRes.json() : {};
    const quota = quotaRes.ok ? await quotaRes.json() : null;
    const messages: MessageRow[] = Array.isArray(payload.messages)
      ? payload.messages.map((m: Omit<MessageRow, "sentAtLabel">) => ({
          ...m,
          sentAtLabel: new Date(m.createdAt).toLocaleString(),
        }))
      : [];
    const students: RecipientStudent[] = Array.isArray(payload.recipients)
      ? payload.recipients
      : [];

    setData({
      className: payload.className ?? "",
      students,
      quota,
      messages,
      loading: false,
    });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const hasQueuedDeliveries = data.messages.some((m) => m.email.queued > 0);
  useEffect(() => {
    if (!hasQueuedDeliveries) return;
    const timer = setInterval(() => {
      load();
    }, DELIVERY_POLL_MS);
    return () => clearInterval(timer);
  }, [hasQueuedDeliveries, load]);

  const remaining = data.quota?.remaining ?? 0;
  const selectedUserIdSet = new Set(selectedUserIds);
  const selectedStudents = data.students.filter((student) => selectedUserIdSet.has(student.userId));
  const targetStudents = recipientMode === "all" ? data.students : selectedStudents;
  const targetInAppCount = targetStudents.length;
  const targetEmailCount = targetStudents.filter((student) => EMAIL_RE.test(student.email)).length;
  const emailOverBudget = targetEmailCount > remaining;
  const canSend = !!form.subject.trim() && !!form.body.trim() && targetInAppCount > 0;

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (sendLock.current) return;
    sendLock.current = true;
    setBanner(null);
    setSending(true);
    try {
      const res = await fetch(`/api/classes/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: form.subject,
          body: form.body,
          ...(recipientMode === "selected" ? { recipientUserIds: selectedUserIds } : {}),
        }),
      });
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        setBanner({ type: "error", text: result.error || "Failed to send message." });
      } else {
        const result = await res.json();
        const notified = result.inApp?.count ?? 0;
        const queued = result.email?.queued ?? 0;
        const text = result.email?.skippedReason
          ? `Notified ${notified} student${notified === 1 ? "" : "s"} in-app. ${result.email.skippedReason}`
          : `Notified ${notified} student${notified === 1 ? "" : "s"} in-app` +
            (queued > 0
              ? `, and queued ${queued} email${queued === 1 ? "" : "s"} for delivery.`
              : ".");
        setBanner({ type: "success", text });
        setForm({ subject: "", body: "" });
        load();
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      sendLock.current = false;
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
          Send an in-app notification to one student, a group, or all of {data.className || "this class"}.
          Students with an email address on file are also emailed a link to it.
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
            <RecipientSelector
              students={data.students}
              mode={recipientMode}
              onModeChange={setRecipientMode}
              selectedUserIds={selectedUserIds}
              onSelectionChange={setSelectedUserIds}
            />

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

            <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm">
              <p className="flex items-start gap-2">
                <Bell className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <span>
                  <strong>
                    {targetInAppCount} student{targetInAppCount === 1 ? "" : "s"}
                  </strong>{" "}
                  will see this under Notifications the next time they open the app.
                </span>
              </p>
              <p className="flex items-start gap-2">
                <Mail className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <span>
                  {targetEmailCount === 0 ? (
                    "No selected students have an email address on file, so no email will be sent."
                  ) : (
                    <>
                      <strong>
                        {targetEmailCount} student{targetEmailCount === 1 ? "" : "s"}
                      </strong>{" "}
                      will also be emailed a link to it, queued and retried until delivered.
                      {data.quota
                        ? ` Email budget: ${data.quota.dailyRemaining} left today, ${data.quota.monthlyRemaining} this month.`
                        : ""}
                    </>
                  )}
                </span>
              </p>
              {targetEmailCount > 0 && emailOverBudget && (
                <p className="flex items-start gap-2 text-destructive">
                  <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                  <span>
                    Only {remaining} email{remaining === 1 ? "" : "s"} left in your budget, so this message will be
                    delivered in-app only. It will email normally once the budget resets.
                  </span>
                </p>
              )}
            </div>

            {targetInAppCount === 0 && (
              <p className="text-xs text-muted-foreground">
                {recipientMode === "selected"
                  ? "Select at least one student."
                  : "No students have joined this class yet. Share an invitation link first."}
              </p>
            )}

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
                    {m.inAppCount > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        <Bell className="size-3 mr-1" /> {m.inAppCount} in-app
                      </Badge>
                    )}
                    {m.email.sent > 0 && (
                      <Badge variant="success" className="text-[10px]">
                        <Mail className="size-3 mr-1" /> {m.email.sent} emailed
                      </Badge>
                    )}
                    {m.email.queued > 0 && (
                      <Badge variant="outline" className="text-[10px]">
                        <Clock className="size-3 mr-1" /> {m.email.queued} queued
                      </Badge>
                    )}
                    {m.email.failed > 0 && (
                      <Badge variant="destructive" className="text-[10px]">
                        <AlertTriangle className="size-3 mr-1" /> {m.email.failed} failed
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{m.body}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {m.sentAtLabel}
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
