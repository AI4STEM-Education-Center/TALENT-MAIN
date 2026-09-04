"use client";

import { useId, useState } from "react";
import { Loader2, MessageSquarePlus, Pencil, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  FEEDBACK_RATING_LABELS,
  FEEDBACK_RATING_MAX,
  FEEDBACK_RATING_SCALE,
  MAX_FEEDBACK_COMMENT_CHARS,
  feedbackSubjectKey,
  type FeedbackSubjectType,
} from "@/lib/content-feedback";
import { useMyFeedback } from "@/components/feedback/my-feedback";

interface FeedbackRatingFormProps {
  subjectType: FeedbackSubjectType;
  /** Simulation id. Null for a recommended material, which has no row id. */
  subjectId?: string | null;
  /** Display title, and the identity of a material (see feedbackSubjectKey). */
  subjectLabel: string;
  /** Free display text stored with the verdict — "pages 4-8", a learning goal. */
  subjectDetail?: string | null;
  /** Required on the student surface: the attempt that surfaced this subject. */
  attemptId?: string | null;
  /** Overrides the "Was this useful?" question for the teacher surface. */
  prompt?: string;
  /** Placeholder for the explanation box — say what a good answer contains. */
  commentPlaceholder?: string;
  className?: string;
}

/**
 * The shared 5-point rating + written explanation control.
 *
 * One component for all three surfaces (a recommended material, a recommended
 * simulation, and a teacher's verdict on a generated simulation) so the scale
 * means the same thing everywhere — the consolidated panel averages these
 * together, which is only honest if every surface asks the same question the
 * same way.
 *
 * Starts as a single row of scale buttons rather than an open form: picking a
 * point is one click and reveals the explanation box already knowing the
 * rating, which is what gets an explanation written at all. The explanation is
 * required, because a bare star tells a teacher a recommendation missed and
 * nothing they can act on.
 */
export function FeedbackRatingForm({
  subjectType,
  subjectId = null,
  subjectLabel,
  subjectDetail = null,
  attemptId = null,
  prompt = "Was this useful?",
  commentPlaceholder = "In a sentence or two — what helped, or what was missing?",
  className,
}: FeedbackRatingFormProps) {
  const store = useMyFeedback();
  const subjectKey = feedbackSubjectKey({
    subjectType,
    subjectId,
    subjectLabel,
    attemptId,
  });
  const saved = store.get(subjectKey);

  const groupId = useId();
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing(nextRating: number | null) {
    setRating(nextRating ?? saved?.rating ?? null);
    setComment(saved?.comment ?? "");
    setError(null);
    setOpen(true);
  }

  async function submit() {
    if (rating === null || !comment.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectType,
          subjectId,
          subjectLabel,
          subjectDetail,
          attemptId,
          rating,
          comment: comment.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Could not save that feedback.");
        return;
      }
      store.record(subjectKey, { rating, comment: comment.trim() });
      setOpen(false);
    } catch {
      setError("Could not save that feedback.");
    } finally {
      setSending(false);
    }
  }

  // Already answered, form closed: show the verdict with a way back in, so a
  // second visit can't silently overwrite it.
  if (!open && saved) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
          className,
        )}
      >
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Star className="size-3.5 fill-primary text-primary" />
          {saved.rating}/{FEEDBACK_RATING_MAX}
        </span>
        <span>{FEEDBACK_RATING_LABELS[saved.rating]}</span>
        <button
          type="button"
          onClick={() => startEditing(null)}
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
        >
          <Pencil className="size-3" aria-hidden="true" />
          Change
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)}>
        <span className="text-xs text-muted-foreground">{prompt}</span>
        <RatingScale
          name={`${groupId}-quick`}
          value={null}
          onChange={startEditing}
          label={`${prompt} ${subjectLabel}`}
        />
      </div>
    );
  }

  const canSubmit = rating !== null && comment.trim().length > 0 && !sending;

  return (
    <div
      className={cn("space-y-2 rounded-lg border bg-muted/20 p-3", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{prompt}</span>
        <RatingScale
          name={groupId}
          value={rating}
          onChange={(next) => setRating(next)}
          label={`${prompt} ${subjectLabel}`}
        />
        {rating !== null && (
          <span className="text-xs text-muted-foreground">
            {FEEDBACK_RATING_LABELS[rating]}
          </span>
        )}
      </div>

      <Textarea
        rows={3}
        autoFocus
        maxLength={MAX_FEEDBACK_COMMENT_CHARS}
        placeholder={commentPlaceholder}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        aria-label={`Explain your rating of ${subjectLabel}`}
        className="text-sm"
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={!canSubmit}>
          {sending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <MessageSquarePlus className="size-3.5" />
          )}
          {saved ? "Update feedback" : "Send feedback"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={sending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The 1-5 scale as native radios: a real radiogroup gets arrow-key navigation,
 * a single tab stop, and screen-reader "3 of 5" announcements for free, which
 * a row of styled buttons would each have to re-implement.
 */
function RatingScale({
  name,
  value,
  onChange,
  label,
}: {
  name: string;
  value: number | null;
  onChange: (rating: number) => void;
  label: string;
}) {
  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">{label}</legend>
      {FEEDBACK_RATING_SCALE.map((point) => (
        <label
          key={point}
          className={cn(
            "flex size-7 cursor-pointer items-center justify-center rounded-md border text-xs font-medium transition-colors",
            "focus-within:ring-2 focus-within:ring-ring",
            value === point
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input bg-background hover:bg-accent",
          )}
        >
          <input
            type="radio"
            name={name}
            value={point}
            checked={value === point}
            onChange={() => onChange(point)}
            className="sr-only"
          />
          <span aria-hidden="true">{point}</span>
          <span className="sr-only">
            {point} — {FEEDBACK_RATING_LABELS[point]}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
