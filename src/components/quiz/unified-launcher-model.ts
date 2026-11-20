// Pure rules behind the unified quiz launcher: which mode can start or resume,
// why a mode is locked, and what exclusion request a set of choices becomes.
// Kept apart from the component so the rules are unit-testable on their own.

import type { QuizQuestionExclusionOptions } from "@/lib/alternative-retake";
import type { UnifiedQuizOverview } from "@/lib/quiz-overview";

export type LaunchMode = "official" | "practice";

export type ModeStatus = {
  /** A started-but-unsubmitted attempt exists and will be continued. */
  resuming: boolean;
  /** The student can press Start/Continue for this mode. */
  canLaunch: boolean;
  /** Why the mode cannot be launched; null when it can. */
  lockedReason: string | null;
  /** Previously-correct questions left out of the attempt being resumed. */
  resumeExcludedCount: number | null;
};

function officialLockReason(overview: UnifiedQuizOverview): string | null {
  const { availability, maxAttempts, gradedAttemptCount } = overview;
  if (availability.notOpenYet) return "This quiz isn't open yet.";
  if (availability.closed) return "This quiz has closed.";
  if (availability.attemptsExhausted)
    return `You've used all ${maxAttempts ?? gradedAttemptCount} graded attempts.`;
  return availability.locked ? "This quiz can't be started right now." : null;
}

export function modeStatus(
  overview: UnifiedQuizOverview,
  mode: LaunchMode,
): ModeStatus {
  if (mode === "official") {
    const resuming = overview.gradedAttempt !== null;
    const reason = officialLockReason(overview);
    return {
      resuming,
      canLaunch: resuming || reason === null,
      lockedReason: resuming ? null : reason,
      resumeExcludedCount: resuming
        ? (overview.gradedAttempt?.excludedQuestionIds.length ?? 0)
        : null,
    };
  }
  const resuming = overview.practiceAttempt !== null;
  const reason =
    overview.practiceAvailableCount === 0
      ? "No alternative versions have been published for this quiz yet."
      : overview.practiceCanStart
        ? null
        : "Alternative versions open while the quiz is open.";
  return {
    resuming,
    canLaunch: resuming || reason === null,
    lockedReason: resuming ? null : reason,
    resumeExcludedCount: null,
  };
}

/** The requested mode when it can launch; otherwise the other one if it can. */
export function defaultMode(
  overview: UnifiedQuizOverview,
  requested: LaunchMode,
): LaunchMode {
  const other: LaunchMode = requested === "official" ? "practice" : "official";
  return !modeStatus(overview, requested).canLaunch &&
    modeStatus(overview, other).canLaunch
    ? other
    : requested;
}

export type OptOutState =
  | { kind: "none" }
  | { kind: "all-correct" }
  | { kind: "choose"; correctIds: string[] };

/** Whether the student gets to choose which right-before questions to skip. */
export function optOutState(overview: UnifiedQuizOverview): OptOutState {
  const total = overview.questions.length;
  const known = new Set(overview.questions.map((q) => q.id));
  const correctIds = overview.previouslyCorrect.filter((id) => known.has(id));
  if (correctIds.length === 0 || total === 0) return { kind: "none" };
  if (correctIds.length >= total) return { kind: "all-correct" };
  return { kind: "choose", correctIds };
}

/**
 * The exclusion request for a set of skipped questions. Skipping every
 * previously-correct question is sent as the shortcut; a hand-picked subset
 * as the explicit list; nothing skipped as no request at all.
 */
export function exclusionFor(
  correctIds: string[],
  skipped: ReadonlySet<string>,
): QuizQuestionExclusionOptions {
  const chosen = correctIds.filter((id) => skipped.has(id));
  if (chosen.length === 0) return {};
  if (chosen.length === correctIds.length) return { excludeCorrect: true };
  return { excludedQuestionIds: chosen };
}
