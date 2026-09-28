"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useAlert, useConfirm } from "@/components/ui/confirm-dialog";
import {
  CalendarClock,
  Loader2,
  Paperclip,
  Save,
  Send,
  TestTube2,
  X,
} from "lucide-react";
import {
  CONSENT_LEVEL_LABELS,
  POST_SURVEY_TARGET_LABELS,
  POST_SURVEY_TARGETS,
  RESEARCH_EMAIL_VARIABLES,
  renderResearchEmail,
  type EmailVariant,
  type PoolAudience,
  type PostSurveyAudience,
  type ResearchEmailAttachment,
  type ResearchEmailKind,
} from "@/lib/research-email";
import { INTERVIEW_RECORDING_CHOICES } from "@/lib/consent-fields";
import type { SurveyRole } from "@/lib/survey";

type Draft = {
  replyTo: string;
  irbSubject: string;
  irbBody: string;
  surveySubject: string;
  surveyBody: string;
  attachments: ResearchEmailAttachment[];
  audience: PoolAudience | PostSurveyAudience;
};

type TextField = "irbSubject" | "irbBody" | "surveySubject" | "surveyBody";

type Preview = {
  count: number;
  irbCount: number;
  surveyCount: number;
  skipped: string[];
  recipients: Array<{
    name: string;
    email: string;
    variant: EmailVariant;
    vars: Record<string, string>;
  }>;
};

type Campaign = {
  id: string;
  status: string;
  scheduledAt: string;
  completedAt: string | null;
  error: string | null;
  irbSubject: string;
  surveySubject: string;
  sent: number;
  failed: number;
  pending: number;
};

const ROLE_OPTIONS: Array<{ value: SurveyRole; label: string }> = [
  { value: "STUDENT", label: "Students" },
  { value: "TEACHER", label: "Teachers" },
];

function formatBytes(n: number): string {
  return n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

/**
 * Compose, test, send or schedule a research email. `kind` POOL writes to the
 * research pool; POST_SURVEY invites people to the post-survey with a personal
 * no-sign-in link ({{surveyLink}}). Both carry two versions — IRB and survey —
 * and each recipient gets the one matching where they agreed.
 */
export function ResearchEmailComposer({ kind }: { kind: ResearchEmailKind }) {
  const alert = useAlert();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const focused = useRef<{
    field: TextField;
    el: HTMLInputElement | HTMLTextAreaElement;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadCampaigns = useCallback(async () => {
    const res = await fetch(
      `/api/admin/research-email/campaigns?kind=${kind}`,
      {
        cache: "no-store",
      },
    );
    if (res.ok) setCampaigns((await res.json()).campaigns);
  }, [kind]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/research-email/template?kind=${kind}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
      .then((data) => {
        if (!controller.signal.aborted) setDraft(data);
      })
      .catch(() => undefined);
    void loadCampaigns();
    return () => controller.abort();
  }, [kind, loadCampaigns]);

  // Poll history while something is scheduled or sending.
  const active = campaigns.some(
    (c) => c.status === "SCHEDULED" || c.status === "SENDING",
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void loadCampaigns(), 10_000);
    return () => clearInterval(timer);
  }, [active, loadCampaigns]);

  // Recipient count + samples follow the audience.
  const audienceKey = draft ? JSON.stringify(draft.audience) : "";
  useEffect(() => {
    if (!audienceKey) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/admin/research-email/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, audience: JSON.parse(audienceKey) }),
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && !controller.signal.aborted) {
            setPreview(data);
            setSampleIndex(0);
          }
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [audienceKey, kind]);

  if (!draft)
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
      </div>
    );

  const set = (patch: Partial<Draft>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  function insertVariable(name: string) {
    const target = focused.current;
    const token = `{{${name}}}`;
    if (!target || !draft) {
      void navigator.clipboard?.writeText(token);
      return;
    }
    const { field, el } = target;
    const value = draft[field];
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    set({ [field]: value.slice(0, start) + token + value.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  const payload = () => ({ kind, ...draft });

  async function call(
    label: string,
    url: string,
    init: RequestInit,
    success?: string,
  ): Promise<boolean> {
    setBusy(label);
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Request failed.");
      if (success) await alert({ title: success });
      return true;
    } catch (error) {
      await alert({
        title: "Something went wrong",
        description: error instanceof Error ? error.message : "Unknown error.",
      });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    const ok = await call("save", "/api/admin/research-email/template", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    });
    if (ok) setSavedAt(new Date().toLocaleTimeString());
  }

  async function sendTest() {
    await call(
      "test",
      "/api/admin/research-email/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload(), to: testTo }),
      },
      `Test emails (both versions) sent to ${testTo}.`,
    );
  }

  async function schedule(when: string | null) {
    const count = preview?.count ?? 0;
    const ok = await confirm({
      title: when ? "Schedule this email?" : "Send this email now?",
      description: when
        ? `It will go out on ${new Date(when).toLocaleString()} to everyone who matches the audience at that time (${count} right now).`
        : `It will go to ${count} recipient${count === 1 ? "" : "s"} within a minute.`,
      confirmText: when ? "Schedule" : "Send",
    });
    if (!ok) return;
    const done = await call("send", "/api/admin/research-email/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload(),
        scheduledAt: when ? new Date(when).toISOString() : null,
      }),
    });
    if (done) {
      setScheduleAt("");
      await loadCampaigns();
    }
  }

  async function cancel(id: string) {
    const ok = await confirm({
      title: "Cancel this send?",
      description: "Emails already sent can't be recalled.",
      confirmText: "Cancel send",
      variant: "destructive",
    });
    if (!ok) return;
    await call("cancel", `/api/admin/research-email/campaigns/${id}`, {
      method: "DELETE",
    });
    await loadCampaigns();
  }

  async function addAttachment(file: File) {
    setBusy("attach");
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch("/api/admin/research-email/attachments", {
        method: "POST",
        body,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Upload failed.");
      setDraft((prev) =>
        prev
          ? { ...prev, attachments: [...prev.attachments, data.attachment] }
          : prev,
      );
    } catch (error) {
      await alert({
        title: "Couldn't attach file",
        description: error instanceof Error ? error.message : "Unknown error.",
      });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const variables = RESEARCH_EMAIL_VARIABLES.filter((v) =>
    v.kinds.includes(kind),
  );
  const sample = preview?.recipients[sampleIndex];
  const sampleVars = sample?.vars ?? {
    name: "Alex Doe",
    firstName: "Alex",
    lastName: "Doe",
    agreedPlace: "the IRB consent form",
    consentLevel: "Interview with audio-only recording",
    role: "Student",
    appName: "AI4Talent",
  };
  const previewVars =
    kind === "POST_SURVEY"
      ? { ...sampleVars, surveyLink: "https://…/survey/(personal link)" }
      : sampleVars;
  const rendered = renderResearchEmail(
    draft,
    sample?.variant ?? "IRB",
    previewVars,
  );

  const fieldProps = (field: TextField) => ({
    value: draft[field],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set({ [field]: e.target.value }),
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      focused.current = { field, el: e.currentTarget };
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recipients</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <AudienceEditor
            kind={kind}
            audience={draft.audience}
            onChange={(audience) => set({ audience })}
          />
          {preview && (
            <div className="space-y-1">
              <p>
                <span className="font-medium">{preview.count}</span> recipient
                {preview.count === 1 ? "" : "s"} right now — {preview.irbCount}{" "}
                get the IRB version, {preview.surveyCount} the survey version.
              </p>
              {preview.skipped.map((s) => (
                <p key={s} className="text-amber-600 dark:text-amber-400">
                  {s}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Message</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="max-w-md space-y-1">
            <Label htmlFor={`${kind}-reply-to`}>
              Reply-to address <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${kind}-reply-to`}
              type="email"
              placeholder="research-team@uga.edu"
              value={draft.replyTo}
              onChange={(e) => set({ replyTo: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              A dedicated inbox — replies from participants go here.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Click a variable to insert it where your cursor is:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {variables.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  title={v.description}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertVariable(v.name)}
                  className="rounded border bg-muted/50 px-2 py-0.5 font-mono text-xs hover:bg-accent"
                >
                  {`{{${v.name}}}`}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {(
              [
                {
                  label: "IRB version",
                  hint: "For people who agreed through the IRB consent form. {{consentLevel}} is filled in.",
                  subject: "irbSubject",
                  body: "irbBody",
                },
                {
                  label: "Survey version",
                  hint:
                    kind === "POOL"
                      ? "For people who agreed through the pre-survey only."
                      : "For everyone without an IRB agreement.",
                  subject: "surveySubject",
                  body: "surveyBody",
                },
              ] as const
            ).map((v) => (
              <div key={v.label} className="space-y-2 rounded-md border p-3">
                <div>
                  <p className="text-sm font-semibold">{v.label}</p>
                  <p className="text-xs text-muted-foreground">{v.hint}</p>
                </div>
                <Input
                  aria-label={`${v.label} subject`}
                  placeholder="Subject"
                  maxLength={300}
                  {...fieldProps(v.subject)}
                />
                <Textarea
                  aria-label={`${v.label} message`}
                  rows={12}
                  maxLength={20000}
                  {...fieldProps(v.body)}
                />
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                aria-label="Attach a file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void addAttachment(file);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => fileRef.current?.click()}
              >
                {busy === "attach" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Paperclip className="size-4" />
                )}
                Attach file
              </Button>
              <span className="text-xs text-muted-foreground">
                Up to 8 MB each, 15 MB total. Sent with both versions.
              </span>
            </div>
            {draft.attachments.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {draft.attachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-1 rounded border px-2 py-1 text-xs"
                  >
                    <Paperclip className="size-3" /> {a.name} (
                    {formatBytes(a.size)})
                    <button
                      type="button"
                      aria-label={`Remove ${a.name}`}
                      className="ml-1 text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        set({
                          attachments: draft.attachments.filter(
                            (x) => x.id !== a.id,
                          ),
                        })
                      }
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Preview
            {sample ? (
              <Badge variant="secondary">
                {sample.variant === "IRB" ? "IRB" : "Survey"} version ·{" "}
                {sample.name}
              </Badge>
            ) : (
              <Badge variant="outline">Sample values</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {preview && preview.recipients.length > 1 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setSampleIndex((i) =>
                    i === 0 ? preview.recipients.length - 1 : i - 1,
                  )
                }
              >
                Previous recipient
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setSampleIndex((i) => (i + 1) % preview.recipients.length)
                }
              >
                Next recipient
              </Button>
              <span className="text-xs text-muted-foreground">
                {sampleIndex + 1} of {preview.recipients.length}
              </span>
            </div>
          )}
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs text-muted-foreground">
              To: {sample?.email ?? "recipient@example.com"} · Reply-to:{" "}
              {draft.replyTo || "(not set)"}
            </p>
            <p className="mt-2 font-semibold">
              {rendered.subject || "(no subject)"}
            </p>
            <pre className="mt-2 whitespace-pre-wrap font-sans">
              {rendered.text || "(empty message)"}
            </pre>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <Button
            variant="outline"
            onClick={saveDraft}
            disabled={busy !== null}
          >
            <Save className="size-4" /> Save draft
          </Button>
          {savedAt && (
            <span className="text-xs text-muted-foreground">
              Saved {savedAt}
            </span>
          )}
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${kind}-test-to`} className="text-xs">
                Send a test to
              </Label>
              <Input
                id={`${kind}-test-to`}
                type="email"
                className="w-56"
                placeholder="you@uga.edu"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              onClick={sendTest}
              disabled={busy !== null || !testTo}
            >
              {busy === "test" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <TestTube2 className="size-4" />
              )}
              Send test
            </Button>
          </div>
          <div className="ml-auto flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${kind}-schedule`} className="text-xs">
                Schedule for
              </Label>
              <Input
                id={`${kind}-schedule`}
                type="datetime-local"
                className="w-56"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              disabled={busy !== null || !scheduleAt}
              onClick={() => schedule(scheduleAt)}
            >
              <CalendarClock className="size-4" /> Schedule
            </Button>
            <Button
              disabled={busy !== null || !preview?.count}
              onClick={() => schedule(null)}
            >
              {busy === "send" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Send now
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-2">When</th>
                    <th className="p-2">Subject</th>
                    <th className="p-2">Status</th>
                    <th className="p-2">Delivered</th>
                    <th className="p-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-t align-top">
                      <td className="whitespace-nowrap p-2 text-xs">
                        {new Date(c.scheduledAt).toLocaleString()}
                      </td>
                      <td className="p-2">
                        {c.irbSubject || c.surveySubject}
                        {c.error && (
                          <p className="text-xs text-amber-600 dark:text-amber-400">
                            {c.error}
                          </p>
                        )}
                      </td>
                      <td className="p-2">
                        <Badge
                          variant={
                            c.status === "SENT"
                              ? "success"
                              : c.status === "FAILED"
                                ? "destructive"
                                : c.status === "CANCELLED"
                                  ? "outline"
                                  : "secondary"
                          }
                        >
                          {c.status.toLowerCase()}
                        </Badge>
                      </td>
                      <td className="p-2 text-xs">
                        {c.sent} sent
                        {c.pending ? ` · ${c.pending} pending` : ""}
                        {c.failed ? ` · ${c.failed} failed` : ""}
                      </td>
                      <td className="p-2 text-right">
                        {(c.status === "SCHEDULED" ||
                          c.status === "SENDING") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => cancel(c.id)}
                          >
                            Cancel
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AudienceEditor({
  kind,
  audience,
  onChange,
}: {
  kind: ResearchEmailKind;
  audience: PoolAudience | PostSurveyAudience;
  onChange: (audience: PoolAudience | PostSurveyAudience) => void;
}) {
  const roles = (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium text-muted-foreground">
        Roles
      </legend>
      <div className="flex flex-wrap gap-4">
        {ROLE_OPTIONS.map((r) => (
          <label key={r.value} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4"
              checked={audience.roles.includes(r.value)}
              onChange={() => {
                const next = toggle(audience.roles, r.value);
                if (next.length) onChange({ ...audience, roles: next });
              }}
            />
            {r.label}
          </label>
        ))}
      </div>
    </fieldset>
  );

  if (kind === "POST_SURVEY") {
    const post = audience as PostSurveyAudience;
    return (
      <div className="space-y-3">
        {roles}
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-muted-foreground">
            Who
          </legend>
          {POST_SURVEY_TARGETS.map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input
                type="radio"
                name="post-survey-target"
                className="size-4"
                checked={post.target === t}
                onChange={() => onChange({ ...post, target: t })}
              />
              {POST_SURVEY_TARGET_LABELS[t]}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-muted-foreground">
          People who already submitted the enabled post-survey are skipped, so
          you can safely schedule reminders.
        </p>
      </div>
    );
  }

  const pool = audience as PoolAudience;
  return (
    <div className="space-y-3">
      {roles}
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-muted-foreground">
          Agreed through
        </legend>
        <div className="flex flex-wrap gap-4">
          {(
            [
              ["IRB", "IRB consent form"],
              ["SURVEY", "Pre-survey interview opt-in"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={pool.sources.includes(value)}
                onChange={() => {
                  const next = toggle(pool.sources, value);
                  if (next.length) onChange({ ...pool, sources: next });
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-muted-foreground">
          IRB consent level (none checked = any)
        </legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {INTERVIEW_RECORDING_CHOICES.map((c) => (
            <label key={c} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={pool.consentLevels.includes(c)}
                onChange={() =>
                  onChange({
                    ...pool,
                    consentLevels: toggle(pool.consentLevels, c),
                  })
                }
              />
              {CONSENT_LEVEL_LABELS[c]}
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4"
              checked={pool.consentLevels.includes("NONE")}
              onChange={() =>
                onChange({
                  ...pool,
                  consentLevels: toggle(pool.consentLevels, "NONE"),
                })
              }
            />
            No IRB agreement (pre-survey only)
          </label>
        </div>
      </fieldset>
    </div>
  );
}
