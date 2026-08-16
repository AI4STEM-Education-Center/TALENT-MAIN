"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, AtSign, Check, ChevronDown, ChevronRight, Loader2, Save } from "lucide-react";

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
          senders: rows.map((r) => ({
            purpose: r.purpose,
            localPart: r.localPart,
            fromName: r.fromName,
            replyTo: r.replyTo,
            subject: r.subject,
            body: r.body,
          })),
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
    <div className="space-y-6 max-w-2xl">
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
                        <span className="block text-sm font-medium">{row.label}</span>
                        <span className="block text-xs text-muted-foreground font-mono truncate">
                          {previewAddress(row.localPart, domain, fallback)}
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
                          <>
                            <div className="space-y-2">
                              <Label htmlFor={`${row.purpose}-subject`}>Subject</Label>
                              <Input
                                id={`${row.purpose}-subject`}
                                value={row.subject ?? ""}
                                onChange={(e) => updateRow(row.purpose, { subject: e.target.value || null })}
                                placeholder={row.defaultTemplate.subject}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor={`${row.purpose}-body`}>Message</Label>
                              <Textarea
                                id={`${row.purpose}-body`}
                                rows={10}
                                value={row.body ?? ""}
                                onChange={(e) => updateRow(row.purpose, { body: e.target.value || null })}
                                placeholder={row.defaultTemplate.body}
                                className="font-mono text-xs"
                              />
                              <p className="text-xs text-muted-foreground">
                                Leave blank to use the built-in wording. Placeholders:{" "}
                                {row.variables.map((v) => (
                                  <span key={v} className="font-mono">{`{{${v}}} `}</span>
                                ))}
                              </p>
                            </div>
                          </>
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
