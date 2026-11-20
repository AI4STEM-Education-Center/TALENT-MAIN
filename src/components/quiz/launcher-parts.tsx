"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  Info,
  Lock,
  PlayCircle,
  Shuffle,
  ClipboardCheck,
} from "lucide-react";
import { MathText } from "@/components/ui/math-text";
import { formatDateTime } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import type { UnifiedQuizOverview } from "@/lib/quiz-overview";
import type { LaunchMode, ModeStatus } from "./unified-launcher-model";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const MODES: readonly LaunchMode[] = ["official", "practice"];

/**
 * The ARIA radiogroup keyboard contract for the mode cards: one tab stop (the
 * checked card, set by ModeCard's roving tabIndex), arrows move the selection
 * and focus with it, wrapping at the ends.
 */
export function onModeKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  mode: LaunchMode,
  onMode: (mode: LaunchMode) => void,
) {
  const step =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (!step) return;
  event.preventDefault();
  const index = MODES.indexOf(mode);
  const next = MODES[(index + step + MODES.length) % MODES.length];
  onMode(next);
  event.currentTarget
    .querySelector<HTMLElement>(`[role="radio"][data-mode="${next}"]`)
    ?.focus();
}

/** One selectable mode: Official Quiz or Alternative Version. */
export function ModeCard({
  mode,
  selected,
  status,
  details,
  onSelect,
}: {
  mode: LaunchMode;
  selected: boolean;
  status: ModeStatus;
  details: ReactNode;
  onSelect: () => void;
}) {
  const official = mode === "official";
  const Icon = official ? ClipboardCheck : Shuffle;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-mode={mode}
      // Roving tab stop: only the checked card is in the tab order; the group's
      // arrow keys move between cards.
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        "relative flex h-full flex-col gap-2 rounded-xl border p-4 text-left transition-[border-color,background-color,box-shadow]",
        selected
          ? "border-primary bg-primary/5 shadow-xs ring-1 ring-primary"
          : "border-border bg-card hover:border-primary/50 hover:bg-muted/30",
        !status.canLaunch && !selected && "opacity-75",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-semibold">
          <Icon className="size-4 text-primary" aria-hidden />
          {official ? "Official quiz" : "Alternative version"}
        </span>
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full border",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/40",
          )}
        >
          {selected && <Check className="size-3" />}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        {official
          ? "Counts toward your grade and uses one of your attempts."
          : "Same learning goals, different questions. Recorded as a retake — your graded score is unchanged."}
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-1 text-xs">
        {details}
        {status.resuming && (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 font-semibold text-blue-700 dark:text-blue-400">
            <PlayCircle className="size-3" aria-hidden /> In progress
          </span>
        )}
      </span>
      {status.lockedReason && (
        <span className="flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-xs text-muted-foreground">
          <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
          {status.lockedReason}
        </span>
      )}
    </button>
  );
}

/** A neutral fact chip on a mode card. */
export function Fact({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function ResumeNote({
  mode,
  excludedCount,
}: {
  mode: LaunchMode;
  excludedCount: number | null;
}) {
  return (
    <Note>
      You have{" "}
      {mode === "official" ? "an official attempt" : "an alternative version"}{" "}
      in progress. Continuing picks up the same question set
      {excludedCount
        ? ` — ${plural(excludedCount, "question")} you already answered correctly ${excludedCount === 1 ? "was" : "were"} left out of it`
        : ""}
      .
    </Note>
  );
}

export function AllCorrectNote({ mode }: { mode: LaunchMode }) {
  return (
    <Note>
      You&apos;ve answered every question correctly before, so the full{" "}
      {mode === "official" ? "quiz" : "version"} will be used.
    </Note>
  );
}

/**
 * Leave out questions already answered correctly — the same choice for the
 * official quiz and for an alternative version. Checked means SKIP; missed
 * questions are always included, so at least one question always remains.
 */
export function OptOutPanel({
  questions,
  correctIds,
  skipped,
  onChange,
}: {
  questions: UnifiedQuizOverview["questions"];
  correctIds: string[];
  skipped: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const correct = new Set(correctIds);
  const skippedCount = correctIds.filter((id) => skipped.has(id)).length;
  const allSkipped = skippedCount === correctIds.length;
  const included = questions.length - skippedCount;
  const toggle = (id: string) => {
    const next = new Set(skipped);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={allSkipped}
          ref={(el) => {
            if (el) el.indeterminate = skippedCount > 0 && !allSkipped;
          }}
          onChange={(event) =>
            onChange(event.target.checked ? new Set(correctIds) : new Set())
          }
          className="mt-1 size-4 accent-[var(--primary)]"
        />
        <span>
          <span className="block text-sm font-semibold">
            Skip all {correctIds.length} question
            {correctIds.length === 1 ? "" : "s"} I already answered correctly
          </span>
          <span className="block text-xs text-muted-foreground">
            Includes questions you got right in your previous official quiz or
            alternative version. {plural(included, "question")} left to
            practice; your score covers only those.
          </span>
        </span>
      </label>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
      >
        <ChevronDown
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          aria-hidden
        />
        Choose individual questions ({included} of {questions.length} selected)
      </button>

      {open && (
        <ul
          aria-label="Questions in this attempt"
          className="relative max-h-80 divide-y overflow-y-auto rounded-lg border"
        >
          {questions.map((question) => {
            const wasCorrect = correct.has(question.id);
            const skip = wasCorrect && skipped.has(question.id);
            return (
              <li
                key={question.id}
                className={cn(
                  "flex items-start gap-3 px-3 py-2 text-sm",
                  skip && "bg-muted/40",
                )}
              >
                <span className="w-8 shrink-0 pt-0.5 text-xs font-semibold text-muted-foreground">
                  Q{question.number}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1",
                    skip &&
                      "text-muted-foreground line-through decoration-muted-foreground/40",
                  )}
                >
                  <span className="line-clamp-2">
                    <MathText text={question.previewText} />
                  </span>
                  <span
                    className={cn(
                      "mt-1 inline-block rounded-full px-1.5 py-px text-[10px] font-semibold",
                      wasCorrect
                        ? "bg-green-600/10 text-green-700 dark:text-green-400"
                        : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
                    )}
                  >
                    {wasCorrect ? "Answered correctly" : "To review"}
                  </span>
                </span>
                {wasCorrect ? (
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 pt-0.5 text-xs">
                    <input
                      type="checkbox"
                      checked={skip}
                      onChange={() => toggle(question.id)}
                      aria-label={`Skip question ${question.number}`}
                      className="size-3.5"
                    />
                    Skip
                  </label>
                ) : (
                  <span className="shrink-0 pt-0.5 text-right text-[11px] text-muted-foreground">
                    Missed / not yet right — always included
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Official and alternative attempts in one list, newest first. */
export function RecentAttempts({
  attempts,
}: {
  attempts: UnifiedQuizOverview["recentAttempts"];
}) {
  return (
    <section aria-labelledby="recent-attempts" className="space-y-2">
      <h2 id="recent-attempts" className="text-sm font-semibold">
        Recent attempts
      </h2>
      {attempts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No attempts yet.</p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {attempts.map((attempt) => (
            <li
              key={attempt.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
            >
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                  attempt.kind === "official"
                    ? "bg-primary/10 text-primary"
                    : "bg-violet-500/10 text-violet-700 dark:text-violet-400",
                )}
              >
                {attempt.kind === "official"
                  ? "Official"
                  : `Alternative: ${attempt.versionName ?? "version"}`}
              </span>
              <span className="font-medium tabular-nums">
                {attempt.completedAt
                  ? `${Math.round(attempt.score ?? 0)}%`
                  : "In progress"}
              </span>
              {attempt.excludedCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {plural(attempt.excludedCount, "question")} skipped
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {formatDateTime(attempt.startedAt)}
              </span>
              {attempt.completedAt && (
                <Link
                  href={`/student/results/${attempt.id}`}
                  className="ml-auto text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  View results
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
