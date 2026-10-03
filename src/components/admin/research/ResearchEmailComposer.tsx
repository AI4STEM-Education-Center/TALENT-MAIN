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
  ChevronLeft,
  ChevronRight,
  GraduationCap,
  Loader2,
  Paperclip,
  RotateCcw,
  Save,
  School,
  Send,
  TestTube2,
  X,
} from "lucide-react";
import {
  CONSENT_LEVEL_LABELS,
  DEFAULT_RESEARCH_EMAIL_VERSIONS,
  INTERVIEW_CONSENT_LEVELS,
  POST_SURVEY_TARGET_LABELS,
  POST_SURVEY_TARGETS,
  RESEARCH_EMAIL_VARIABLES,
  renderResearchEmail,
  VERSION_LABELS,
  versionKeysFor,
  type PoolAudience,
  type PostSurveyAudience,
  type ResearchEmailAttachment,
  type ResearchEmailKind,
  type ResearchEmailVersions,
  type VersionKey,
} from "@/lib/research-email";
import type { SurveyRole } from "@/lib/survey";

type Draft = {
  replyTo: string;
  versions: ResearchEmailVersions;
  attachments: ResearchEmailAttachment[];
  audience: PoolAudience | PostSurveyAudience;
};

type Part = "subject" | "body";

type Preview = {
  count: number;
  byVersion: Partial<Record<VersionKey, number>>;
  skipped: string[];
  recipients: Array<{
    name: string;
    email: string;
    variant: VersionKey;
    vars: Record<string, string>;
  }>;
};

type Campaign = {
  id: string;
  status: string;
  scheduledAt: string;
  completedAt: string | null;
  error: string | null;
  subject: string;
  sent: number;
  failed: number;
  pending: number;
};

const ROLES: Array<{
  value: SurveyRole;
  label: string;
  plural: string;
  icon: typeof GraduationCap;
}> = [
  {
    value: "STUDENT",
    label: "Student",
    plural: "Students",
    icon: GraduationCap,
  },
  { value: "TEACHER", label: "Teacher", plural: "Teachers", icon: School },
];

const VERSION_HINTS: Partial<Record<VersionKey, string>> = {
  STUDENT_IRB:
    "For students who agreed to an interview on the IRB consent form. {{consentLevel}} is filled in.",
  STUDENT_SURVEY:
    "For students who opted in to an interview on the pre-survey only.",
  TEACHER_IRB:
    "For teachers who agreed to an interview on the IRB consent form. {{consentLevel}} is filled in.",
  TEACHER_SURVEY:
    "For teachers who opted in to an interview on the pre-survey only.",
};

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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function keysForRole(kind: ResearchEmailKind, role: SurveyRole): VersionKey[] {
  return versionKeysFor(kind, [role]);
}

function sampleVarsFor(key: VersionKey): Record<string, string> {
  const survey = key.endsWith("_SURVEY");
  return {
    name: "Alex Doe",
    firstName: "Alex",
    lastName: "Doe",
    agreedPlace: survey ? "the pre-survey" : "the IRB consent form",
    consentLevel: survey ? "" : "Interview with audio-only recording",
    role: key.startsWith("TEACHER") ? "Teacher" : "Student",
    appName: "AI4Talent",
  };
}

/**
 * Compose, test, send or schedule a research email. `kind` POST_SURVEY invites
 * people to the post-survey with a personal no-sign-in link ({{surveyLink}}) —
 * one version per role. POOL is the interview invitation to people who agreed
 * to an interview — an IRB and a survey version per role.
 */
export function ResearchEmailComposer({ kind }: { kind: ResearchEmailKind }) {
  const alert = useAlert();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savedJson, setSavedJson] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editRole, setEditRole] = useState<SurveyRole>("STUDENT");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const focused = useRef<{
    key: VersionKey;
    part: Part;
    el: HTMLInputElement | HTMLTextAreaElement;
  } | null>(null);
  const isInterview = kind === "POOL";

  const loadCampaigns = useCallback(async () => {
    const res = await fetch(
      `/api/admin/research-email/campaigns?kind=${kind}`,
      { cache: "no-store" },
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
        if (controller.signal.aborted) return;
        const loaded: Draft = {
          replyTo: data.replyTo,
          versions: data.versions,
          attachments: data.attachments,
          audience: data.audience,
        };
        setDraft(loaded);
        setSavedJson(JSON.stringify(loaded));
        setEditRole(loaded.audience.roles[0] ?? "STUDENT");
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
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
          if (data && !controller.signal.aborted) setPreview(data);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [audienceKey, kind]);

  if (loadFailed)
    return (
      <p className="py-12 text-center text-sm text-destructive">
        Couldn&apos;t load the saved email. Reload the page to try again.
      </p>
    );
  if (!draft)
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
      </div>
    );

  const set = (patch: Partial<Draft>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  const setVersion = (key: VersionKey, part: Part, value: string) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const current = prev.versions[key] ?? { subject: "", body: "" };
      return {
        ...prev,
        versions: { ...prev.versions, [key]: { ...current, [part]: value } },
      };
    });

  function insertVariable(name: string) {
    const target = focused.current;
    const token = `{{${name}}}`;
    if (!target || !draft) {
      void navigator.clipboard?.writeText(token);
      return;
    }
    const { key, part, el } = target;
    const value = draft.versions[key]?.[part] ?? "";
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    setVersion(key, part, value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function resetVersion(key: VersionKey) {
    const ok = await confirm({
      title: `Reset the ${VERSION_LABELS[key]}?`,
      description:
        "Its subject and message go back to the built-in template. Nothing is saved until you save the draft.",
      confirmText: "Reset",
    });
    const fallback = DEFAULT_RESEARCH_EMAIL_VERSIONS[kind][key];
    if (ok && fallback)
      setDraft((prev) =>
        prev
          ? { ...prev, versions: { ...prev.versions, [key]: { ...fallback } } }
          : prev,
      );
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
    const snapshot = JSON.stringify(draft);
    const ok = await call("save", "/api/admin/research-email/template", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    });
    if (ok) setSavedJson(snapshot);
  }

  const sendKeys = versionKeysFor(kind, draft.audience.roles);

  async function sendTest(testTo: string) {
    await call(
      "test",
      "/api/admin/research-email/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload(), to: testTo }),
      },
      `${plural(sendKeys.length, "test email")} sent to ${testTo} — one per version.`,
    );
  }

  async function schedule(when: string | null): Promise<boolean> {
    const count = preview?.count ?? 0;
    const ok = await confirm({
      title: when ? "Schedule this email?" : "Send this email now?",
      description: when
        ? `It will go out on ${new Date(when).toLocaleString()} to everyone who matches the recipients at that time (${count} right now).`
        : `It will go to ${plural(count, "recipient")} within a minute.`,
      confirmText: when ? "Schedule" : "Send",
    });
    if (!ok) return false;
    const snapshot = JSON.stringify(draft);
    const done = await call("send", "/api/admin/research-email/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload(),
        scheduledAt: when ? new Date(when).toISOString() : null,
      }),
    });
    if (done) {
      // Scheduling also saves the draft.
      setSavedJson(snapshot);
      await loadCampaigns();
    }
    return done;
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
    }
  }

  const dirty = JSON.stringify(draft) !== savedJson;
  const editKeys = keysForRole(kind, editRole);
  const roleSelected = draft.audience.roles.includes(editRole);
  const editRoleInfo = ROLES.find((r) => r.value === editRole)!;

  const fieldProps = (key: VersionKey, part: Part) => ({
    value: draft.versions[key]?.[part] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setVersion(key, part, e.target.value),
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      focused.current = { key, part, el: e.currentTarget };
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
          <RecipientSummary preview={preview} sendKeys={sendKeys} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Message</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <ReplyToField
            kind={kind}
            value={draft.replyTo}
            onChange={(replyTo) => set({ replyTo })}
          />

          <div className="space-y-3">
            <RoleTabs
              value={editRole}
              sendingRoles={draft.audience.roles}
              onChange={setEditRole}
            />

            {!roleSelected && (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                {editRoleInfo.plural} aren&apos;t selected under Recipients, so
                this email won&apos;t be sent. You can still edit and save it.
              </p>
            )}

            <VariableChips kind={kind} onInsert={insertVariable} />

            <div
              className={`grid gap-4 ${editKeys.length > 1 ? "lg:grid-cols-2" : ""}`}
            >
              {editKeys.map((key) => (
                <VersionCard
                  key={key}
                  kind={kind}
                  versionKey={key}
                  roleLabel={editRoleInfo.label}
                  subjectProps={fieldProps(key, "subject")}
                  bodyProps={fieldProps(key, "body")}
                  onReset={() => resetVersion(key)}
                />
              ))}
            </div>
          </div>

          <AttachmentsField
            attachments={draft.attachments}
            busy={busy}
            onAdd={addAttachment}
            onRemove={(id) =>
              set({
                attachments: draft.attachments.filter((x) => x.id !== id),
              })
            }
          />
        </CardContent>
      </Card>

      <PreviewCard
        key={editRole}
        kind={kind}
        versions={draft.versions}
        replyTo={draft.replyTo}
        editKeys={editKeys}
        rolePlural={editRoleInfo.plural}
        recipients={preview?.recipients ?? []}
      />

      <SendCard
        kind={kind}
        busy={busy}
        dirty={dirty}
        sendKeys={sendKeys}
        count={preview?.count ?? 0}
        onSave={saveDraft}
        onTest={sendTest}
        onSchedule={schedule}
      />

      <HistoryCard campaigns={campaigns} onCancel={cancel} />
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
        {ROLES.map((r) => (
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
            {r.plural}
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
          Agreed to an interview through
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
      {pool.sources.includes("IRB") && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-muted-foreground">
            IRB recording level (none checked = any)
          </legend>
          <div className="grid gap-1 sm:grid-cols-3">
            {INTERVIEW_CONSENT_LEVELS.map((c) => (
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
          </div>
        </fieldset>
      )}
      <p className="text-xs text-muted-foreground">
        Only people who agreed to an interview are included — IRB participants
        who chose &ldquo;{CONSENT_LEVEL_LABELS.NO_INTERVIEW}&rdquo; are left out
        unless they also opted in on the pre-survey.
      </p>
    </div>
  );
}

function RecipientSummary({
  preview,
  sendKeys,
}: {
  preview: Preview | null;
  sendKeys: VersionKey[];
}) {
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3">
      {preview ? (
        <>
          <p>
            <span className="text-lg font-semibold">{preview.count}</span>{" "}
            recipient{preview.count === 1 ? "" : "s"} right now
          </p>
          {sendKeys.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {sendKeys.map((key) => (
                <Badge key={key} variant="outline" className="font-normal">
                  {VERSION_LABELS[key]}:{" "}
                  <span className="ml-1 font-semibold">
                    {preview.byVersion[key] ?? 0}
                  </span>
                </Badge>
              ))}
            </div>
          )}
          {preview.skipped.map((s) => (
            <p key={s} className="text-amber-600 dark:text-amber-400">
              {s}
            </p>
          ))}
        </>
      ) : (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Counting recipients…
        </p>
      )}
    </div>
  );
}

function RoleTabs({
  value,
  sendingRoles,
  onChange,
}: {
  value: SurveyRole;
  sendingRoles: SurveyRole[];
  onChange: (role: SurveyRole) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Which role's email to edit"
      className="flex flex-wrap gap-1 border-b"
    >
      {ROLES.map((r) => {
        const selected = value === r.value;
        return (
          <button
            key={r.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(r.value)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              selected
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <r.icon className="size-4" />
            {r.label} email
            {!sendingRoles.includes(r.value) && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                not sending
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

type FieldProps = {
  value: string;
  onChange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  onFocus: (
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
};

function VersionCard({
  kind,
  versionKey,
  roleLabel,
  subjectProps,
  bodyProps,
  onReset,
}: {
  kind: ResearchEmailKind;
  versionKey: VersionKey;
  roleLabel: string;
  subjectProps: FieldProps;
  bodyProps: FieldProps;
  onReset: () => void;
}) {
  const isInterview = kind === "POOL";
  const title = !isInterview
    ? VERSION_LABELS[versionKey]
    : versionKey.endsWith("_IRB")
      ? "IRB version"
      : "Survey version";
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">
            {VERSION_HINTS[versionKey] ??
              `Sent to every ${roleLabel.toLowerCase()} who gets the post-survey email. Must include {{surveyLink}}.`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-xs text-muted-foreground"
          onClick={onReset}
        >
          <RotateCcw className="size-3.5" /> Reset to template
        </Button>
      </div>
      <Input
        aria-label={`${VERSION_LABELS[versionKey]} subject`}
        placeholder="Subject"
        maxLength={300}
        {...subjectProps}
      />
      <Textarea
        aria-label={`${VERSION_LABELS[versionKey]} message`}
        rows={isInterview ? 18 : 12}
        maxLength={20000}
        {...bodyProps}
      />
    </div>
  );
}

function HistoryCard({
  campaigns,
  onCancel,
}: {
  campaigns: Campaign[];
  onCancel: (id: string) => void;
}) {
  return (
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
                      {c.subject}
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
                      {(c.status === "SCHEDULED" || c.status === "SENDING") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onCancel(c.id)}
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
  );
}

function ReplyToField({
  kind,
  value,
  onChange,
}: {
  kind: ResearchEmailKind;
  value: string;
  onChange: (value: string) => void;
}) {
  const required = kind === "POOL";
  return (
    <div className="max-w-md space-y-1">
      <Label htmlFor={`${kind}-reply-to`}>
        Reply-to address{" "}
        {required ? (
          <span className="text-destructive">*</span>
        ) : (
          <span className="font-normal text-muted-foreground">(optional)</span>
        )}
      </Label>
      <Input
        id={`${kind}-reply-to`}
        type="email"
        placeholder="research-team@uga.edu"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        {required
          ? "Required — people reply here when none of the interview times work."
          : "Leave blank to use the default sender's reply-to address."}
      </p>
    </div>
  );
}

function VariableChips({
  kind,
  onInsert,
}: {
  kind: ResearchEmailKind;
  onInsert: (name: string) => void;
}) {
  const variables = RESEARCH_EMAIL_VARIABLES.filter((v) =>
    v.kinds.includes(kind),
  );
  return (
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
            onClick={() => onInsert(v.name)}
            className="rounded border bg-muted/50 px-2 py-0.5 font-mono text-xs hover:bg-accent"
          >
            {`{{${v.name}}}`}
          </button>
        ))}
      </div>
    </div>
  );
}

function AttachmentsField({
  attachments,
  busy,
  onAdd,
  onRemove,
}: {
  attachments: ResearchEmailAttachment[];
  busy: string | null;
  onAdd: (file: File) => void;
  onRemove: (id: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          aria-label="Attach a file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onAdd(file);
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
          Up to 8 MB each, 15 MB total. Sent with every version.
        </span>
      </div>
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-1 rounded border px-2 py-1 text-xs"
            >
              <Paperclip className="size-3" /> {a.name} ({formatBytes(a.size)})
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                className="ml-1 text-muted-foreground hover:text-foreground"
                onClick={() => onRemove(a.id)}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Renders the role being edited, stepping through the people who'd get it. */
function PreviewCard({
  kind,
  versions,
  replyTo,
  editKeys,
  rolePlural,
  recipients,
}: {
  kind: ResearchEmailKind;
  versions: ResearchEmailVersions;
  replyTo: string;
  editKeys: VersionKey[];
  rolePlural: string;
  recipients: Preview["recipients"];
}) {
  const [index, setIndex] = useState(0);
  const samples = recipients.filter((r) => editKeys.includes(r.variant));
  const current = samples.length ? Math.min(index, samples.length - 1) : 0;
  const sample = samples[current];
  const sampleKey = sample?.variant ?? editKeys[0];
  const vars = {
    ...(sample?.vars ?? sampleVarsFor(sampleKey)),
    ...(kind === "POST_SURVEY"
      ? { surveyLink: "https://…/survey/(personal link)" }
      : {}),
  };
  const rendered = renderResearchEmail(versions, sampleKey, vars);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Preview
          <Badge variant="secondary">{VERSION_LABELS[sampleKey]}</Badge>
          {sample ? (
            <Badge variant="outline">{sample.name}</Badge>
          ) : (
            <Badge variant="outline">Sample values</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {samples.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-label="Previous recipient"
              onClick={() =>
                setIndex((i) => (i <= 0 ? samples.length - 1 : i - 1))
              }
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-20 text-center text-xs text-muted-foreground">
              {current + 1} of {samples.length}
            </span>
            <Button
              size="sm"
              variant="outline"
              aria-label="Next recipient"
              onClick={() => setIndex((i) => (i + 1) % samples.length)}
            >
              <ChevronRight className="size-4" />
            </Button>
            <span className="text-xs text-muted-foreground">
              {rolePlural.toLowerCase()} who would get this email
            </span>
          </div>
        )}
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">
            To: {sample?.email ?? "recipient@example.com"} · Reply-to:{" "}
            {replyTo || "(default)"}
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
  );
}

function SendCard({
  kind,
  busy,
  dirty,
  sendKeys,
  count,
  onSave,
  onTest,
  onSchedule,
}: {
  kind: ResearchEmailKind;
  busy: string | null;
  dirty: boolean;
  sendKeys: VersionKey[];
  count: number;
  onSave: () => void;
  onTest: (to: string) => void;
  onSchedule: (when: string | null) => Promise<boolean>;
}) {
  const [testTo, setTestTo] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Send</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={onSave}
            disabled={busy !== null || !dirty}
          >
            {busy === "save" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save draft
          </Button>
          <span
            className={`text-xs ${dirty ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
          >
            {dirty ? "Unsaved changes" : "All changes saved"}
          </span>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor={`${kind}-test-to`} className="text-sm">
              Send a test
            </Label>
            <p className="text-xs text-muted-foreground">
              Sends {plural(sendKeys.length, "email")} — one per version (
              {sendKeys.map((k) => VERSION_LABELS[k]).join(", ")}) — with sample
              values.
            </p>
            <div className="flex gap-2">
              <Input
                id={`${kind}-test-to`}
                type="email"
                placeholder="you@uga.edu"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
              />
              <Button
                variant="outline"
                onClick={() => onTest(testTo)}
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
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <Label htmlFor={`${kind}-schedule`} className="text-sm">
              Send to {plural(count, "recipient")}
            </Label>
            <p className="text-xs text-muted-foreground">
              Recipients are worked out again when it goes out.
              {kind === "POST_SURVEY" &&
                " People who already submitted the post-survey are skipped."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                id={`${kind}-schedule`}
                type="datetime-local"
                className="w-56"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={busy !== null || !scheduleAt}
                onClick={async () => {
                  if (await onSchedule(scheduleAt)) setScheduleAt("");
                }}
              >
                <CalendarClock className="size-4" /> Schedule
              </Button>
              <Button
                disabled={busy !== null || !count}
                onClick={() => void onSchedule(null)}
              >
                {busy === "send" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                Send now
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
