"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { STEP_LABEL, type GuidedStepId } from "./guided-steps";

/**
 * The stepper across the top. Steps already visited can be revisited; the
 * ones ahead stay put until the student gets there, which keeps the review
 * guided without trapping anyone (the quiet "Skip to end" is always there).
 */
export function StepProgress({
  steps,
  active,
  visited,
  onSelect,
}: {
  steps: GuidedStepId[];
  active: GuidedStepId;
  visited: ReadonlySet<GuidedStepId>;
  onSelect: (step: GuidedStepId) => void;
}) {
  const activeIndex = steps.indexOf(active);
  return (
    <nav aria-label="Review progress">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Step {activeIndex + 1} of {steps.length} · {STEP_LABEL[active]}
      </p>
      <ol className="flex items-center gap-1.5 sm:gap-2">
        {steps.map((step, index) => {
          const isActive = step === active;
          const done = !isActive && visited.has(step) && index < activeIndex;
          const reachable = visited.has(step) && !isActive;
          return (
            <li key={step} className="flex min-w-0 flex-1 items-center gap-1.5">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => onSelect(step)}
                aria-current={isActive ? "step" : undefined}
                aria-label={`${STEP_LABEL[step]}${done ? " (done)" : ""}`}
                className={cn(
                  "flex min-w-0 items-center gap-1.5 rounded-full text-left text-xs font-medium transition-colors disabled:cursor-default",
                  reachable && "hover:text-foreground",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors",
                    isActive &&
                      "border-primary bg-primary text-primary-foreground shadow-xs",
                    done && "border-primary/40 bg-primary/10 text-primary",
                    !isActive && !done && "border-border bg-background",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : index + 1}
                </span>
                <span className="hidden truncate md:inline">
                  {STEP_LABEL[step]}
                </span>
              </button>
              {index < steps.length - 1 && (
                <span
                  aria-hidden
                  className={cn(
                    "h-px min-w-3 flex-1 rounded-full",
                    index < activeIndex ? "bg-primary/40" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The heading block at the top of each step. */
export function StepHeader({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="space-y-1">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        {icon}
        {title}
      </h2>
      {children && (
        <p className="max-w-3xl text-sm text-muted-foreground">{children}</p>
      )}
    </header>
  );
}

/** The main forward button of a step. */
export function AdvanceButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button type="button" onClick={onClick}>
      {label} <ArrowRight aria-hidden />
    </Button>
  );
}

/**
 * Deliberately quiet ways out of the guided review: plain muted text, no
 * border or background, tucked at the bottom edge. They exist so nobody is
 * forced through every step — not to compete with the step's own button.
 */
export function QuietExitLinks({
  onSkipToEnd,
  backHref,
  backLabel,
}: {
  /** Omitted on the last step, where there is nothing left to skip. */
  onSkipToEnd?: () => void;
  backHref?: string;
  backLabel?: string;
}) {
  const linkClass =
    "text-muted-foreground/55 underline-offset-2 transition-colors hover:text-muted-foreground hover:underline focus-visible:text-muted-foreground focus-visible:outline-hidden focus-visible:underline";
  const showBack = !!backHref && backHref !== "/student";
  return (
    <nav
      aria-label="Leave the guided review"
      className="flex flex-wrap items-center justify-end gap-x-1.5 pt-2 text-[11px] text-muted-foreground/55"
    >
      {onSkipToEnd && (
        <>
          <button type="button" onClick={onSkipToEnd} className={linkClass}>
            Skip to end
          </button>
          <span aria-hidden>·</span>
        </>
      )}
      <Link href="/student" className={linkClass}>
        Go back home
      </Link>
      {showBack && (
        <>
          <span aria-hidden>·</span>
          <Link href={backHref} className={linkClass}>
            {backLabel ?? "Back"}
          </Link>
        </>
      )}
    </nav>
  );
}
