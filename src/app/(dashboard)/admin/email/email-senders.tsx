"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  RotateCcw,
  Save,
} from "lucide-react";

interface SenderRow {
  purpose: string;
  label: string;
  description: string;
  defaultLocalPart: string;
  defaultTemplate: { subject: string; body: string } | null;
  variables: string[];
  localPart: string;
  fromName: string | null;
  replyTo: string | null;
  subject: string | null;
  body: string | null;
  resolved: { fromEmail: string; fromName: string | null; replyTo: string | null };
}

interface SendersPayload {
  senderDomain: string | null;
  fallbackFromEmail: string;
  smtpConfigured: boolean;
  senders: SenderRow[];
}

/** Live preview of the address a row will send from, before saving. */
function previewAddress(localPart: string, domain: string, fallback: string): string {
  const trimmedDomain = domain.trim().replace(/^@/, "");
  const trimmedLocal = localPart.trim();
  if (!trimmedDomain) return fallback || "(set a From Email above)";
  return `${trimmedLocal || "…"}@${trimmedDomain}`;
}

/** Client-side twin of renderTemplate() in src/lib/email-purposes.ts. */
function renderPreview(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

/** Sample values so every template previews exactly as a receiver would see it. */
const SAMPLE_VARS: Record<string, Record<string, string | number>> = {
  PASSWORD_RESET: {
    appName: "AI4Talent",
    firstName: "Ada",
    lastName: "Lovelace",
    username: "ada.lovelace@example.com",
    resetUrl: "https://app.example.com/reset-password?token=sample-token",
    expiresInMinutes: 60,
  },
  PASSWORD_CHANGED: {
    appName: "AI4Talent",
    firstName: "Ada",
    lastName: "Lovelace",
    username: "ada.lovelace@example.com",
    changedAt: "September 3, 2026 at 10:15 AM UTC",
    resetRequestUrl: "https://app.example.com/forgot-password",
  },
  NOTIFICATION: {
    appName: "AI4Talent",
    senderName: "Jordan Lee",
    className: "Biology 101",
    subject: "Field trip on Friday",
    subjectLine: "New message in Biology 101: Field trip on Friday",
    greetingLine: "Jordan Lee has sent you a new message in Biology 101.",
    messageUrl: "https://app.example.com/student/notifications?message=msg_123",
    messageLinkLine: "Read it here: https://app.example.com/student/notifications?message=msg_123",
  },
  CONTACT_TEACHER: {
    appName: "AI4Talent",
    studentName: "Ada Lovelace",
    studentEmail: "ada@example.com",
    className: "Biology 101",
    subject: "Question about homework",
    subjectLine: "[Biology 101] Question about homework",
    body: "Hi, I had a question about problem 3 from last night's assignment.",
  },
  SYSTEM_TEST: {
    appName: "AI4Talent",
    fromEmail: "no-reply@example.net",
    purposeLabel: "SMTP test",
  },
  CONSENT_CONFIRMATION: {
    appName: "AI4Talent",
    firstName: "Ada",
    lastName: "Lovelace",
    formTitle: "Research Participation Consent",
    formVersion: "2026-08-06",
    decisionText: "Yes, I agree to participate",
  },
  CONSENT_EXPORT_REQUEST: {
    appName: "AI4Talent",
    teacherName: "Jordan Lee",
    className: "Biology 101",
    gradeColumnName: "Consent Credit",
    pointsAwarded: 5,
    reviewUrl: "https://app.example.com/admin/consent-requests?request=req_123",
  },
  CONSENT_EXPORT_READY: {
    appName: "AI4Talent",
    className: "Biology 101",
    gradeColumnName: "Consent Credit",
    pointsAwarded: 5,
  },
  SECURITY_ALERT: {
    appName: "AI4Talent",
    tokenName: "GitHub Actions — prod",
    tokenPrefix: "ptr_Ab12Cd",
    usedAt: "2026-09-03T10:15:00.000Z",
    ip: "203.0.113.42",
    useCount: 3,
  },
};

function ReceiverPreview({
  row,
  subject,
  body,
  fromEmail,
  fromName,
}: {
  row: SenderRow;
  subject: string;
  body: string;
  fromEmail: string;
  fromName: string | null;
}) {
  const vars = SAMPLE_VARS[row.purpose] ?? { appName: "AI4Talent" };
  const previewSubject = renderPreview(subject, vars);
  const previewBody = renderPreview(body, vars);
  const fromLine = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/60 border-b border-border">
        <Eye className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          Live receiver preview — updates as you type (sample data)
        </span>
      </div>
      <div className="px-3 py-3 space-y-2 bg-background">
        <div className="text-xs">
          <span className="text-muted-foreground">From: </span>
          <span className="font-mono break-all">{fromLine}</span>
        </div>
        <div className="text-xs">
          <span className="text-muted-foreground">To: </span>
          <span className="font-mono">ada@example.com</span>
        </div>
        <div className="text-xs">
          <span className="text-muted-foreground">Subject: </span>
          <span className="font-medium">{previewSubject}</span>
        </div>
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-3 text-sm whitespace-pre-wrap break-words">
          {previewBody}
        </div>
      </div>
    </div>
  );
}

export function EmailSenders() {
  const [payload, setPayload] = useState<SendersPayload | null>(null);
  const [domain, setDomain] = useState("");
  const [rows, setRows] = useState<SenderRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const applyPayload = useCallback((data: SendersPayload) => {
    setPayload(data);
    setDomain(data.senderDomain ?? "");
    setRows(data.senders);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/email-senders");
      if (res.ok) applyPayload((await res.json()) as SendersPayload);
    } finally {
      setLoading(false);
    }
  }, [applyPayload]);

  useEffect(() => {
    load();
  }, [load]);

  function updateRow(purpose: string, patch: Partial<SenderRow>) {
    setRows((prev) => prev.map((r) => (r.purpose === purpose ? { ...r, ...patch } : r)));
  }

  function resetTemplate(purpose: string) {
    updateRow(purpose, { subject: null, body: null });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/email-senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderDomain: domain,
          senders: rows.map((r) => {
            // The editor always shows the effective copy (override ?? default)
            // so the admin works directly on real wording. A field cleared to
            // empty (or left equal to the default after Reset) is sent as null
            // so the server keeps rendering the built-in wording.
            const defaultSubject = r.defaultTemplate?.subject ?? "";
            const defaultBody = r.defaultTemplate?.body ?? "";
            const subject = (r.subject ?? defaultSubject).trim();
            const body = (r.body ?? defaultBody).trim();
            return {
              purpose: r.purpose,
              localPart: r.localPart,
              fromName: r.fromName,
              replyTo: r.replyTo,
              subject:
                !subject || (r.subject === null && subject === defaultSubject.trim()) ? null : subject,
              body: !body || (r.body === null && body === defaultBody.trim()) ? null : body,
            };
          }),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: "error", text: data.error || "Failed to save sender addresses." });
      } else {
        applyPayload(data as SendersPayload);
        setBanner({ type: "success", text: "Sender addresses saved." });
      }
    } catch {
      setBanner({ type: "error", text: "An unexpected error occurred." });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const fallback = payload?.fallbackFromEmail ?? "";

  return (
    <div className="space-y-6 max-w-5xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AtSign className="size-4" /> Sender addresses
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSave} className="space-y-5">
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

            <div className="space-y-2">
              <Label htmlFor="senderDomain">Shared sender domain</Label>
              <Input
                id="senderDomain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="example.net"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Every email below is sent from{" "}
                <span className="font-mono">prefix@{domain.trim().replace(/^@/, "") || "your-domain"}</span>. Your SMTP
                server must be allowed to send as this domain (SPF/DKIM). Leave it blank to send everything from the
                single From Email above{fallback ? ` (${fallback})` : ""}.
              </p>
              {!payload?.smtpConfigured && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  Save the SMTP server settings above first — the domain is stored alongside them.
                </p>
              )}
            </div>

            <div className="space-y-3">
              {rows.map((row) => {
                const isOpen = expanded === row.purpose;
                // The editor works directly on the effective copy: a saved
                // override when present, otherwise the built-in default. Saving
                // persists the edited text; Reset restores the built-in.
                const effectiveSubject = row.subject ?? row.defaultTemplate?.subject ?? "";
                const effectiveBody = row.body ?? row.defaultTemplate?.body ?? "";
                const customized = row.subject !== null || row.body !== null;
                const fromPreview = previewAddress(row.localPart, domain, fallback);
                return (
                  <div key={row.purpose} className="rounded-lg border border-border">
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : row.purpose)}
                      aria-expanded={isOpen}
                      className="w-full flex items-start gap-2 p-3 text-left hover:bg-accent/50 transition-colors rounded-lg"
                    >
                      {isOpen ? (
                        <ChevronDown className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {row.label}
                          {customized && (
                            <Badge variant="secondary" className="text-[10px]">
                              Customized
                            </Badge>
                          )}
                        </span>
                        <span className="block text-xs text-muted-foreground font-mono truncate">
                          {fromPreview}
                        </span>
                      </span>
                    </button>

                    {isOpen && (
                      <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border">
                        <p className="text-xs text-muted-foreground pt-2">{row.description}</p>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label htmlFor={`${row.purpose}-local`}>Address prefix</Label>
                            <Input
                              id={`${row.purpose}-local`}
                              value={row.localPart}
                              onChange={(e) => updateRow(row.purpose, { localPart: e.target.value })}
                              placeholder={row.defaultLocalPart}
                              autoComplete="off"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor={`${row.purpose}-name`}>
                              Display name <span className="text-muted-foreground">(optional)</span>
                            </Label>
                            <Input
                              id={`${row.purpose}-name`}
                              value={row.fromName ?? ""}
                              onChange={(e) => updateRow(row.purpose, { fromName: e.target.value || null })}
                              placeholder="AI4Talent"
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor={`${row.purpose}-reply`}>
                            Reply-to <span className="text-muted-foreground">(optional)</span>
                          </Label>
                          <Input
                            id={`${row.purpose}-reply`}
                            type="email"
                            value={row.replyTo ?? ""}
                            onChange={(e) => updateRow(row.purpose, { replyTo: e.target.value || null })}
                            placeholder="support@example.net"
                          />
                          <p className="text-xs text-muted-foreground">
                            Where replies go. Leave blank for a no-reply mailbox. Messages a teacher or student writes
                            always reply to that person instead.
                          </p>
                        </div>

                        {row.defaultTemplate ? (
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                            <div className="space-y-3 min-w-0">
                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <Label htmlFor={`${row.purpose}-subject`}>Subject</Label>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs"
                                    onClick={() => resetTemplate(row.purpose)}
                                    title="Restore the built-in wording"
                                  >
                                    <RotateCcw className="size-3 mr-1" /> Reset to default
                                  </Button>
                                </div>
                                <Input
                                  id={`${row.purpose}-subject`}
                                  value={effectiveSubject}
                                  onChange={(e) => updateRow(row.purpose, { subject: e.target.value })}
                                  placeholder={row.defaultTemplate.subject}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor={`${row.purpose}-body`}>Message</Label>
                                <Textarea
                                  id={`${row.purpose}-body`}
                                  rows={14}
                                  value={effectiveBody}
                                  onChange={(e) => updateRow(row.purpose, { body: e.target.value })}
                                  placeholder={row.defaultTemplate.body}
                                  className="font-mono text-xs"
                                />
                                <p className="text-xs text-muted-foreground">
                                  Edit the built-in wording directly — it is pre-filled below. Available placeholders:{" "}
                                  {row.variables.map((v) => (
                                    <span key={v} className="font-mono">{`{{${v}}} `}</span>
                                  ))}
                                </p>
                              </div>
                            </div>
                            <div className="min-w-0 lg:sticky lg:top-4">
                              <ReceiverPreview
                                row={row}
                                subject={effectiveSubject}
                                body={effectiveBody}
                                fromEmail={fromPreview}
                                fromName={row.fromName}
                              />
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            The subject and message for these emails are written by the teacher or student sending
                            them, so only the sender identity is configurable here.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {saving ? "Saving..." : "Save sender addresses"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
