"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAlert, useConfirm } from "@/components/ui/confirm-dialog";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Eye,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  DEFAULT_LIKERT_SCALE,
  normalizeSurveyQuestions,
  questionTakesOptions,
  SURVEY_KIND_LABELS,
  SURVEY_QUESTION_TYPE_LABELS,
  SURVEY_QUESTION_TYPES,
  SURVEY_ROLE_LABELS,
  type SurveyKind,
  type SurveyQuestion,
  type SurveyQuestionType,
  type SurveyRole,
} from "@/lib/survey";
import { SurveyFormView } from "@/components/survey/SurveyFormView";

type FormDetail = {
  id: string;
  kind: SurveyKind;
  role: SurveyRole;
  title: string;
  description: string;
  questions: SurveyQuestion[];
  isEnabled: boolean;
  status: string;
  errorMessage: string | null;
  hasPdf: boolean;
  hasSourceText: boolean;
  responseCount: number;
};

function newQuestion(type: SurveyQuestionType = "likert"): SurveyQuestion {
  return {
    id: `n${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
    type,
    text: "",
    help: "",
    options: type === "likert" ? [...DEFAULT_LIKERT_SCALE] : [],
    otherLabel: "",
    required: type !== "section",
  };
}

export default function SurveyEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const alert = useAlert();
  const confirm = useConfirm();
  const [form, setForm] = useState<FormDetail | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [questions, setQuestions] = useState<SurveyQuestion[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/surveys/${id}`, { cache: "no-store" });
    if (!res.ok) {
      await alert({ title: "Survey not found" });
      return;
    }
    const data: FormDetail = await res.json();
    setForm(data);
    setTitle(data.title);
    setDescription(data.description);
    setQuestions(data.questions);
    setDirty(false);
  }, [id, alert]);

  useEffect(() => {
    void load();
  }, [load]);

  const extracting = form?.status === "EXTRACTING";
  useEffect(() => {
    if (!extracting) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [extracting, load]);

  function update(index: number, patch: Partial<SurveyQuestion>) {
    setQuestions((prev) =>
      prev.map((q, i) => {
        if (i !== index) return q;
        const next = { ...q, ...patch };
        if (patch.type && patch.type !== q.type) {
          if (patch.type === "likert" && next.options.length < 2)
            next.options = [...DEFAULT_LIKERT_SCALE];
          if (!questionTakesOptions(patch.type)) next.options = [];
          if (patch.type === "section") next.required = false;
        }
        return next;
      }),
    );
    setDirty(true);
  }

  function move(index: number, delta: number) {
    setQuestions((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
  }

  function removeAt(index: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  function insertAfter(index: number, type: SurveyQuestionType) {
    setQuestions((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, newQuestion(type));
      return next;
    });
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/surveys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, questions }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Could not save.");
      await load();
    } catch (error) {
      await alert({
        title: "Couldn't save",
        description: error instanceof Error ? error.message : "Unknown error.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function reextract() {
    const ok = await confirm({
      title: "Convert the PDF again with AI?",
      description:
        "The current questions will be replaced by a fresh AI conversion of the uploaded PDF, and the survey will be disabled until you re-enable it.",
      confirmText: "Convert again",
    });
    if (!ok) return;
    const res = await fetch(`/api/admin/surveys/${id}/extract`, {
      method: "POST",
    });
    const data = await res.json().catch(() => null);
    if (!res.ok)
      await alert({
        title: "Couldn't start conversion",
        description: data?.error ?? "Unknown error.",
      });
    await load();
  }

  if (!form)
    return (
      <div className="flex justify-center p-12 text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
      </div>
    );

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            href="/admin/surveys"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Surveys
          </Link>
          <h1 className="text-2xl font-bold">
            {SURVEY_ROLE_LABELS[form.role]}{" "}
            {SURVEY_KIND_LABELS[form.kind].toLowerCase()}
          </h1>
          <div className="flex flex-wrap gap-2">
            {form.isEnabled ? (
              <Badge>Enabled</Badge>
            ) : (
              <Badge variant="outline">Disabled</Badge>
            )}
            <Badge variant="secondary">{form.responseCount} responses</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {form.hasSourceText && form.responseCount === 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={reextract}
              disabled={extracting}
            >
              <Sparkles className="size-4" /> Convert PDF again
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPreview((p) => !p)}
          >
            <Eye className="size-4" /> {preview ? "Edit" : "Preview"}
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || saving || extracting}
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
        </div>
      </div>

      {extracting && (
        <Card>
          <CardContent className="flex items-center gap-2 py-4 text-sm">
            <Loader2 className="size-4 animate-spin" /> Converting the PDF with
            AI — this usually takes under a minute.
          </CardContent>
        </Card>
      )}
      {form.errorMessage && !extracting && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          {form.errorMessage}
        </p>
      )}
      {form.responseCount > 0 && (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          This survey already has responses. Answers are stored per question, so
          fixing wording is safe, but removing or changing the meaning of a
          question affects how existing responses read in the export.
        </p>
      )}

      {preview ? (
        <Card>
          <CardContent className="pt-6">
            <SurveyFormView
              form={{
                id: form.id,
                title,
                description,
                questions: normalizeSurveyQuestions(questions),
              }}
              interviewDefaultEmail={form.kind === "PRE" ? "" : undefined}
              submitLabel="Submit (preview — nothing is saved)"
              onSubmit={async () => {
                await alert({
                  title: "Looks good",
                  description:
                    "All required questions are answered. Nothing was saved — this is a preview.",
                });
                return { ok: true };
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="space-y-1">
                <Label htmlFor="survey-title">Title</Label>
                <Input
                  id="survey-title"
                  value={title}
                  maxLength={200}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setDirty(true);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="survey-description">Introduction</Label>
                <Textarea
                  id="survey-description"
                  rows={3}
                  value={description}
                  maxLength={4000}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setDirty(true);
                  }}
                />
              </div>
              {form.kind === "PRE" && (
                <p className="text-xs text-muted-foreground">
                  Every pre-survey automatically ends with the follow-up
                  interview contact section (email opt-in, research purposes
                  only). Don&apos;t add one here.
                </p>
              )}
            </CardContent>
          </Card>

          {questions.length === 0 && (
            <Button variant="outline" onClick={() => insertAfter(-1, "likert")}>
              <Plus className="size-4" /> Add the first question
            </Button>
          )}

          <div className="space-y-3">
            {questions.map((q, index) => (
              <QuestionEditor
                key={q.id}
                question={q}
                index={index}
                total={questions.length}
                onChange={(patch) => update(index, patch)}
                onMove={(delta) => move(index, delta)}
                onRemove={() => removeAt(index)}
                onInsert={(type) => insertAfter(index, type)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function QuestionEditor({
  question: q,
  index,
  total,
  onChange,
  onMove,
  onRemove,
  onInsert,
}: {
  question: SurveyQuestion;
  index: number;
  total: number;
  onChange: (patch: Partial<SurveyQuestion>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onInsert: (type: SurveyQuestionType) => void;
}) {
  const takesOptions = questionTakesOptions(q.type);
  return (
    <Card className={q.type === "section" ? "border-dashed" : undefined}>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={q.type}
            onValueChange={(v) => onChange({ type: v as SurveyQuestionType })}
          >
            <SelectTrigger className="w-56" aria-label="Question type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SURVEY_QUESTION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {SURVEY_QUESTION_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {q.type !== "section" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={q.required}
                onChange={(e) => onChange({ required: e.target.checked })}
              />
              Required
            </label>
          )}
          <div className="ml-auto flex gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Move up"
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Move down"
              disabled={index === total - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDown className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Delete question"
              onClick={onRemove}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        <Textarea
          aria-label={q.type === "section" ? "Heading" : "Question"}
          placeholder={
            q.type === "section" ? "Section heading" : "Question text"
          }
          rows={2}
          value={q.text}
          maxLength={2000}
          onChange={(e) => onChange({ text: e.target.value })}
        />
        <Input
          aria-label="Help text"
          placeholder={
            q.type === "section"
              ? "Instructions shown under the heading (optional)"
              : "Help text (optional)"
          }
          value={q.help}
          maxLength={2000}
          onChange={(e) => onChange({ help: e.target.value })}
        />

        {takesOptions && (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Options — one per line</Label>
              <Textarea
                rows={Math.max(3, q.options.length + 1)}
                value={q.options.join("\n")}
                onChange={(e) =>
                  onChange({ options: e.target.value.split("\n") })
                }
              />
            </div>
            {q.type !== "likert" && (
              <div className="space-y-1">
                <Label className="text-xs">
                  Write-in option (e.g. “Other”) — leave blank for none
                </Label>
                <Input
                  value={q.otherLabel}
                  maxLength={300}
                  onChange={(e) => onChange({ otherLabel: e.target.value })}
                />
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">Insert below:</span>
          {(["likert", "single", "textarea", "section"] as const).map((t) => (
            <Button
              key={t}
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => onInsert(t)}
            >
              <Plus className="size-3" /> {SURVEY_QUESTION_TYPE_LABELS[t]}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
