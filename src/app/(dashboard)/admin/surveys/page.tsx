"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAlert, useConfirm } from "@/components/ui/confirm-dialog";
import {
  Loader2,
  Upload,
  FileText,
  Pencil,
  Table2,
  Trash2,
  Mail,
  Users,
} from "lucide-react";
import {
  SURVEY_KIND_LABELS,
  SURVEY_ROLE_LABELS,
  type SurveyKind,
  type SurveyRole,
} from "@/lib/survey";
import { extractPdfText } from "@/lib/pdf-text-client";

type FormRow = {
  id: string;
  kind: SurveyKind;
  role: SurveyRole;
  title: string;
  isEnabled: boolean;
  status: string;
  errorMessage: string | null;
  pdfName: string | null;
  hasPdf: boolean;
  responseCount: number;
  questionCount: number;
  updatedAt: string;
};

type TemplateRow = {
  key: string;
  kind: SurveyKind;
  role: SurveyRole;
  title: string;
};

const GROUPS: Array<{ kind: SurveyKind; role: SurveyRole }> = [
  { kind: "PRE", role: "STUDENT" },
  { kind: "PRE", role: "TEACHER" },
  { kind: "POST", role: "STUDENT" },
  { kind: "POST", role: "TEACHER" },
];

export default function AdminSurveysPage() {
  const alert = useAlert();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [forms, setForms] = useState<FormRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploadKind, setUploadKind] = useState<SurveyKind>("PRE");
  const [uploadRole, setUploadRole] = useState<SurveyRole>("STUDENT");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/surveys", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load surveys.");
      const data = await res.json();
      setForms(data.forms);
      setTemplates(data.templates);
    } catch (error) {
      await alert({
        title: "Couldn't load surveys",
        description: error instanceof Error ? error.message : "Unknown error.",
      });
    } finally {
      setLoading(false);
    }
  }, [alert]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while an AI extraction is running.
  const extracting = forms.some((f) => f.status === "EXTRACTING");
  useEffect(() => {
    if (!extracting) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [extracting, load]);

  async function upload(file: File) {
    setBusy("upload");
    try {
      let text = "";
      try {
        text = await extractPdfText(file);
      } catch {
        throw new Error("This PDF could not be read. Is it a valid PDF?");
      }
      const body = new FormData();
      body.set("file", file);
      body.set("text", text);
      body.set("kind", uploadKind);
      body.set("role", uploadRole);
      const res = await fetch("/api/admin/surveys/upload", {
        method: "POST",
        body,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Upload failed.");
      await load();
    } catch (error) {
      await alert({
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Unknown error.",
      });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function createFromTemplate(templateKey: string) {
    setBusy(templateKey);
    try {
      const res = await fetch("/api/admin/surveys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateKey }),
      });
      if (!res.ok) throw new Error("Could not create the survey.");
      await load();
    } catch (error) {
      await alert({
        title: "Couldn't create survey",
        description: error instanceof Error ? error.message : "Unknown error.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function setEnabled(form: FormRow, isEnabled: boolean) {
    if (isEnabled) {
      const ok = await confirm({
        title: `Enable “${form.title}”?`,
        description:
          form.kind === "PRE"
            ? `${SURVEY_ROLE_LABELS[form.role]}s who agreed to the IRB consent form will be required to complete it; everyone else will be invited to. Any other enabled ${SURVEY_ROLE_LABELS[form.role].toLowerCase()} pre-survey is turned off.`
            : `Post-survey emails for ${SURVEY_ROLE_LABELS[form.role].toLowerCase()}s will link to this form. Any other enabled ${SURVEY_ROLE_LABELS[form.role].toLowerCase()} post-survey is turned off.`,
        confirmText: "Enable",
      });
      if (!ok) return;
    }
    setBusy(form.id);
    try {
      const res = await fetch(`/api/admin/surveys/${form.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not update.");
      await load();
    } catch (error) {
      await alert({
        title: "Couldn't update survey",
        description: error instanceof Error ? error.message : "Unknown error.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function remove(form: FormRow) {
    const ok = await confirm({
      title: `Delete “${form.title}”?`,
      description: "This can't be undone.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const res = await fetch(`/api/admin/surveys/${form.id}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok)
      await alert({
        title: "Couldn't delete",
        description: data?.error ?? "Unknown error.",
      });
    await load();
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Surveys</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Pre- and post-platform-use surveys for students and teachers. The
            enabled pre-survey is required for anyone who agreed to the IRB
            consent form and offered to everyone else; post-surveys are sent by
            email with a personal link.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/research-pool">
              <Users className="size-4" /> Research pool
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/post-survey-email">
              <Mail className="size-4" /> Post-survey email
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a survey</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Survey</Label>
              <Select
                value={uploadKind}
                onValueChange={(v) => setUploadKind(v as SurveyKind)}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PRE">Pre-survey</SelectItem>
                  <SelectItem value="POST">Post-survey</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">For</Label>
              <Select
                value={uploadRole}
                onValueChange={(v) => setUploadRole(v as SurveyRole)}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="STUDENT">Students</SelectItem>
                  <SelectItem value="TEACHER">Teachers</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              aria-label="Survey PDF"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null}
            >
              {busy === "upload" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              Upload survey PDF
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The PDF is converted into an editable online form (with AI when a
            model is assigned to “Research Survey PDF Extraction” in AI Config).
            Always review the questions before enabling it. The original PDF is
            kept for reference.
          </p>
          {templates.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                Or start from a study instrument
              </p>
              <div className="flex flex-wrap gap-2">
                {templates.map((t) => (
                  <Button
                    key={t.key}
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => createFromTemplate(t.key)}
                  >
                    {busy === t.key ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <FileText className="size-4" />
                    )}
                    {t.title}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {GROUPS.map(({ kind, role }) => {
            const group = forms.filter(
              (f) => f.kind === kind && f.role === role,
            );
            return (
              <Card key={`${kind}-${role}`}>
                <CardHeader>
                  <CardTitle className="text-base">
                    {SURVEY_ROLE_LABELS[role]}{" "}
                    {SURVEY_KIND_LABELS[kind].toLowerCase()}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {group.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No survey yet.
                    </p>
                  )}
                  {group.map((f) => (
                    <div
                      key={f.id}
                      className="space-y-2 rounded-md border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{f.title}</span>
                        {f.isEnabled ? (
                          <Badge>Enabled</Badge>
                        ) : (
                          <Badge variant="outline">Disabled</Badge>
                        )}
                        {f.status === "EXTRACTING" && (
                          <Badge variant="secondary">
                            <Loader2 className="mr-1 size-3 animate-spin" />
                            Converting with AI…
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {f.questionCount} questions · {f.responseCount}{" "}
                        responses
                        {f.pdfName ? ` · from ${f.pdfName}` : ""}
                      </p>
                      {f.errorMessage && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          {f.errorMessage}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={f.isEnabled ? "outline" : "default"}
                          disabled={busy !== null || f.status === "EXTRACTING"}
                          onClick={() => setEnabled(f, !f.isEnabled)}
                        >
                          {f.isEnabled ? "Disable" : "Enable"}
                        </Button>
                        <Button size="sm" variant="outline" asChild>
                          <Link href={`/admin/surveys/${f.id}`}>
                            <Pencil className="size-4" /> Edit
                          </Link>
                        </Button>
                        <Button size="sm" variant="outline" asChild>
                          <Link href={`/admin/surveys/${f.id}/responses`}>
                            <Table2 className="size-4" /> Responses
                          </Link>
                        </Button>
                        {f.hasPdf && (
                          <Button size="sm" variant="ghost" asChild>
                            <a
                              href={`/api/admin/surveys/${f.id}/pdf`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <FileText className="size-4" /> PDF
                            </a>
                          </Button>
                        )}
                        {f.responseCount === 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete ${f.title}`}
                            onClick={() => remove(f)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
