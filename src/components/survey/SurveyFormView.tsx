"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  INTERVIEW_CONTACT_COPY,
  isOtherAnswer,
  validateSurveyAnswers,
  type SurveyAnswers,
  type SurveyQuestion,
} from "@/lib/survey";

export type SurveyFormData = {
  id: string;
  title: string;
  description: string;
  questions: SurveyQuestion[];
};

export type InterviewChoice = { optIn: boolean; email: string };

type SubmitResult =
  { ok: true } | { ok: false; error: string; questionId?: string };

/**
 * Renders a research survey and collects its answers. Used by the dashboard's
 * pre-survey modal and by the public post-survey link page; each caller owns
 * the network call through `onSubmit`. With `interviewDefaultEmail` set, the
 * form ends with the interview-contact opt-in (pre-surveys only).
 */
export function SurveyFormView({
  form,
  interviewDefaultEmail,
  onSubmit,
  submitLabel = "Submit survey",
  footer,
}: {
  form: SurveyFormData;
  interviewDefaultEmail?: string;
  onSubmit: (
    answers: SurveyAnswers,
    interview: InterviewChoice | null,
  ) => Promise<SubmitResult>;
  submitLabel?: string;
  footer?: React.ReactNode;
}) {
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [interview, setInterview] = useState<InterviewChoice>({
    optIn: false,
    email: interviewDefaultEmail ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [errorQuestion, setErrorQuestion] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const withInterview = interviewDefaultEmail !== undefined;
  let number = 0;

  /** Fold typed "Other" text into the stored answer ("Other: …"). */
  function resolvedAnswers(): SurveyAnswers {
    const out: SurveyAnswers = {};
    for (const q of form.questions) {
      const value = answers[q.id];
      if (value === undefined) continue;
      const withOther = (v: string) =>
        q.otherLabel && v === q.otherLabel && otherText[q.id]?.trim()
          ? `${q.otherLabel}: ${otherText[q.id].trim()}`
          : v;
      out[q.id] = Array.isArray(value)
        ? value.map(withOther)
        : withOther(value);
    }
    return out;
  }

  function focusQuestion(id: string) {
    document
      .getElementById(`survey-q-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function handleSubmit() {
    const final = resolvedAnswers();
    const check = validateSurveyAnswers(form.questions, final);
    if (!check.ok) {
      setError(check.error);
      setErrorQuestion(check.questionId ?? null);
      if (check.questionId) focusQuestion(check.questionId);
      return;
    }
    setSubmitting(true);
    setError(null);
    setErrorQuestion(null);
    try {
      const result = await onSubmit(
        check.answers,
        withInterview ? interview : null,
      );
      if (!result.ok) {
        setError(result.error);
        setErrorQuestion(result.questionId ?? null);
        if (result.questionId) focusQuestion(result.questionId);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function setSingle(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  function toggleMulti(id: string, value: string) {
    setAnswers((prev) => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      return {
        ...prev,
        [id]: current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value],
      };
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold leading-tight">{form.title}</h2>
        {form.description && (
          <p className="whitespace-pre-line text-sm text-muted-foreground">
            {form.description}
          </p>
        )}
      </div>

      {form.questions.map((q) => {
        if (q.type === "section") {
          return (
            <div key={q.id} className="border-b pb-1 pt-2">
              <h3 className="text-base font-semibold">{q.text}</h3>
              {q.help && (
                <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
                  {q.help}
                </p>
              )}
            </div>
          );
        }
        number += 1;
        const value = answers[q.id];
        const name = `survey-${form.id}-${q.id}`;
        const choices = q.otherLabel ? [...q.options, q.otherLabel] : q.options;
        return (
          <fieldset
            key={q.id}
            id={`survey-q-${q.id}`}
            className={cn(
              "space-y-2 rounded-md p-1",
              errorQuestion === q.id && "ring-2 ring-destructive/60",
            )}
          >
            <legend className="text-sm font-medium">
              {number}. {q.text}
              {q.required ? (
                <span className="ml-1 text-destructive" aria-hidden>
                  *
                </span>
              ) : (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              )}
            </legend>
            {q.help && (
              <p className="text-xs text-muted-foreground">{q.help}</p>
            )}

            {q.type === "likert" && (
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => (
                  <label
                    key={opt}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                      value === opt
                        ? "border-primary bg-primary/10"
                        : "border-input hover:bg-accent",
                    )}
                  >
                    <input
                      type="radio"
                      name={name}
                      className="size-4"
                      checked={value === opt}
                      onChange={() => setSingle(q.id, opt)}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            )}

            {(q.type === "single" || q.type === "multi") && (
              <div className="space-y-1.5">
                {choices.map((opt) => {
                  const checked =
                    q.type === "multi"
                      ? Array.isArray(value) && value.includes(opt)
                      : value === opt;
                  return (
                    <label key={opt} className="flex items-start gap-2 text-sm">
                      <input
                        type={q.type === "multi" ? "checkbox" : "radio"}
                        name={name}
                        className="mt-0.5 size-4"
                        checked={checked}
                        onChange={() =>
                          q.type === "multi"
                            ? toggleMulti(q.id, opt)
                            : setSingle(q.id, opt)
                        }
                      />
                      <span>{opt}</span>
                    </label>
                  );
                })}
                {q.otherLabel &&
                  (Array.isArray(value)
                    ? value.some((v) => isOtherAnswer(q, v))
                    : typeof value === "string" && isOtherAnswer(q, value)) && (
                    <Input
                      aria-label={`${q.otherLabel} — please specify`}
                      placeholder="Please specify"
                      className="ml-6 max-w-sm"
                      value={otherText[q.id] ?? ""}
                      maxLength={500}
                      onChange={(e) =>
                        setOtherText((prev) => ({
                          ...prev,
                          [q.id]: e.target.value,
                        }))
                      }
                    />
                  )}
              </div>
            )}

            {q.type === "text" && (
              <Input
                aria-label={q.text}
                value={typeof value === "string" ? value : ""}
                maxLength={5000}
                onChange={(e) => setSingle(q.id, e.target.value)}
              />
            )}
            {q.type === "textarea" && (
              <Textarea
                aria-label={q.text}
                rows={4}
                value={typeof value === "string" ? value : ""}
                maxLength={5000}
                onChange={(e) => setSingle(q.id, e.target.value)}
              />
            )}
          </fieldset>
        );
      })}

      {withInterview && (
        <fieldset className="space-y-3 rounded-md border bg-muted/40 p-4">
          <legend className="px-1 text-base font-semibold">
            {INTERVIEW_CONTACT_COPY.heading}
          </legend>
          <p className="text-sm text-muted-foreground">
            {INTERVIEW_CONTACT_COPY.body}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={interview.optIn}
              onChange={(e) =>
                setInterview((prev) => ({ ...prev, optIn: e.target.checked }))
              }
            />
            <span>{INTERVIEW_CONTACT_COPY.checkbox}</span>
          </label>
          {interview.optIn && (
            <div className="space-y-1">
              <label
                htmlFor={`survey-${form.id}-interview-email`}
                className="text-sm font-medium"
              >
                {INTERVIEW_CONTACT_COPY.emailLabel}
              </label>
              <Input
                id={`survey-${form.id}-interview-email`}
                type="email"
                className="max-w-sm"
                value={interview.email}
                maxLength={254}
                onChange={(e) =>
                  setInterview((prev) => ({ ...prev, email: e.target.value }))
                }
              />
            </div>
          )}
        </fieldset>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? "Submitting…" : submitLabel}
        </Button>
        {footer}
      </div>
    </div>
  );
}
