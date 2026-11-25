"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Loader2, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QuizQuestionExclusionOptions } from "@/lib/alternative-retake";
import { QuizPlayer } from "./QuizPlayer";
import {
  fetchUnifiedQuizOverview,
  type UnifiedQuizOverview,
} from "./quiz-session";
import {
  AllCorrectNote,
  Fact,
  ModeCard,
  onModeKeyDown,
  OptOutPanel,
  RecentAttempts,
  ResumeNote,
} from "./launcher-parts";
import {
  defaultMode,
  exclusionFor,
  modeStatus,
  optOutState,
  type LaunchMode,
  type ModeStatus,
} from "./unified-launcher-model";

type Launch = {
  mode: LaunchMode;
  exclusionOptions: QuizQuestionExclusionOptions;
  /** Remounts the player for every launch, so each starts its own attempt. */
  key: number;
};

/**
 * The launcher's overview. `reloading` stays true until the newest request
 * settles: only the latest request may write (an older, slower response never
 * overwrites a fresher one), and a failed reload keeps the cached overview on
 * screen but reports the error, since launching from stale state could resume
 * the wrong attempt.
 */
function useQuizOverview(classId: string, quizId: string) {
  const [overview, setOverview] = useState<UnifiedQuizOverview | null>(null);
  const [error, setError] = useState("");
  const [reloading, setReloading] = useState(true);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setError("");
    setReloading(true);
    try {
      const next = await fetchUnifiedQuizOverview(classId, quizId);
      if (request !== requestRef.current) return;
      setOverview(next);
    } catch (e) {
      if (request !== requestRef.current) return;
      setError(e instanceof Error ? e.message : "Could not load this quiz.");
    } finally {
      if (request === requestRef.current) setReloading(false);
    }
  }, [classId, quizId]);
  useEffect(() => {
    void load();
    // Unmount (or a new quiz): drop whatever is still in flight.
    return () => {
      requestRef.current += 1;
    };
  }, [load]);
  return { overview, error, reloading, reload: load };
}

function officialFacts(overview: UnifiedQuizOverview) {
  const { maxAttempts, gradedAttemptCount } = overview;
  return maxAttempts
    ? `Attempts ${gradedAttemptCount}/${maxAttempts}`
    : `${gradedAttemptCount} completed · unlimited attempts`;
}

/**
 * One place to take a quiz: choose the official quiz or an alternative
 * version, decide whether to skip what you already got right, then start.
 * Finishing (or "Retake" / "Practice another version") comes back here with
 * refreshed history.
 */
export function UnifiedQuizLauncher({
  classId,
  quizId,
  initialMode,
  backHref,
  backLabel,
}: {
  classId: string;
  quizId: string;
  initialMode: LaunchMode;
  backHref: string;
  backLabel: string;
}) {
  const { overview, error, reloading, reload } = useQuizOverview(
    classId,
    quizId,
  );
  // null = untouched, so the default follows the loaded overview.
  const [modeChoice, setModeChoice] = useState<LaunchMode | null>(null);
  const [skipChoice, setSkipChoice] = useState<ReadonlySet<string> | null>(
    null,
  );
  const [launch, setLaunch] = useState<Launch | null>(null);

  const backToSetup = (mode?: LaunchMode) => {
    setLaunch(null);
    if (mode) setModeChoice(mode);
    setSkipChoice(null);
    void reload();
  };

  if (launch)
    return (
      <>
        <div className="px-4 pt-4 md:px-6">
          <Button variant="ghost" size="sm" onClick={() => backToSetup()}>
            <Settings2 className="size-4" /> Quiz options
          </Button>
        </div>
        <QuizPlayer
          key={launch.key}
          mode={launch.mode === "official" ? "student" : "practice"}
          classId={classId}
          quizId={quizId}
          exclusionOptions={launch.exclusionOptions}
          onBackToSetup={backToSetup}
          backHref={backHref}
          backLabel={backLabel}
        />
      </>
    );

  const header = (
    <Button variant="ghost" size="sm" asChild>
      <Link href={backHref}>
        <ArrowLeft className="size-4" /> {backLabel}
      </Link>
    </Button>
  );

  if (!overview)
    return (
      <div className="max-w-3xl space-y-4 p-4 md:p-6">
        {header}
        {error ? (
          <div role="alert" className="space-y-2 rounded-xl border p-4">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        ) : (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin text-primary" /> Loading
            quiz…
          </p>
        )}
      </div>
    );

  return (
    <LauncherSetup
      overview={overview}
      header={header}
      refresh={{ reloading, error, retry: () => void reload() }}
      mode={modeChoice ?? defaultMode(overview, initialMode)}
      onMode={setModeChoice}
      skipChoice={skipChoice}
      onSkipChoice={setSkipChoice}
      onLaunch={(mode, exclusionOptions) =>
        setLaunch((prev) => ({
          mode,
          exclusionOptions,
          key: (prev?.key ?? 0) + 1,
        }))
      }
    />
  );
}

/** What happens to already-right questions in the selected mode. */
function QuestionChoice({
  overview,
  mode,
  status,
  correctIds,
  skipped,
  onSkipChoice,
  canChoose,
  allCorrect,
}: {
  overview: UnifiedQuizOverview;
  mode: LaunchMode;
  status: ModeStatus;
  correctIds: string[];
  skipped: ReadonlySet<string>;
  onSkipChoice: (skipped: Set<string>) => void;
  canChoose: boolean;
  allCorrect: boolean;
}) {
  if (status.resuming)
    return (
      <ResumeNote mode={mode} excludedCount={status.resumeExcludedCount} />
    );
  if (allCorrect) return <AllCorrectNote mode={mode} />;
  if (!canChoose) return null;
  return (
    <OptOutPanel
      questions={overview.questions}
      correctIds={correctIds}
      skipped={skipped}
      onChange={onSkipChoice}
    />
  );
}

/** The choices before starting: mode, skipped questions, recent attempts. */
function LauncherSetup({
  overview,
  header,
  refresh,
  mode,
  onMode,
  skipChoice,
  onSkipChoice,
  onLaunch,
}: {
  overview: UnifiedQuizOverview;
  header: ReactNode;
  /** State of the latest refresh of a cached overview. */
  refresh: { reloading: boolean; error: string; retry: () => void };
  mode: LaunchMode;
  onMode: (mode: LaunchMode) => void;
  /** null = untouched: skip every previously-correct question. */
  skipChoice: ReadonlySet<string> | null;
  onSkipChoice: (skipped: Set<string>) => void;
  onLaunch: (
    mode: LaunchMode,
    exclusionOptions: QuizQuestionExclusionOptions,
  ) => void;
}) {
  const status = modeStatus(overview, mode);
  const optOut = optOutState(overview);
  const correctIds = optOut.kind === "choose" ? optOut.correctIds : [];
  const canChoose = optOut.kind === "choose";
  const skipped = skipChoice ?? new Set(correctIds);
  const skippedCount = status.resuming
    ? 0
    : correctIds.filter((id) => skipped.has(id)).length;
  const questionCount = overview.questions.length - skippedCount;

  return (
    <div className="max-w-3xl space-y-6 p-4 md:p-6">
      {header}
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">
          {overview.quiz.name}
        </h1>
        {overview.quiz.topicName && (
          <p className="text-sm text-muted-foreground">
            {overview.quiz.topicName}
          </p>
        )}
      </header>

      {refresh.error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <p className="min-w-0 flex-1 text-sm text-destructive">
            Could not refresh this quiz: {refresh.error}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh.retry}
            disabled={refresh.reloading}
          >
            Try again
          </Button>
        </div>
      )}

      <div
        role="radiogroup"
        aria-label="How do you want to take this quiz?"
        onKeyDown={(event) => onModeKeyDown(event, mode, onMode)}
        className="grid gap-3 sm:grid-cols-2"
      >
        <ModeCard
          mode="official"
          selected={mode === "official"}
          status={modeStatus(overview, "official")}
          details={<Fact>{officialFacts(overview)}</Fact>}
          onSelect={() => onMode("official")}
        />
        <ModeCard
          mode="practice"
          selected={mode === "practice"}
          status={modeStatus(overview, "practice")}
          details={
            <Fact>
              {overview.practiceAvailableCount} version
              {overview.practiceAvailableCount === 1 ? "" : "s"} published
            </Fact>
          }
          onSelect={() => onMode("practice")}
        />
      </div>

      {status.canLaunch && (
        <QuestionChoice
          overview={overview}
          mode={mode}
          status={status}
          correctIds={correctIds}
          skipped={skipped}
          onSkipChoice={onSkipChoice}
          canChoose={optOut.kind === "choose"}
          allCorrect={optOut.kind === "all-correct"}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          // Launch only from a fresh overview: a stale one may point at an
          // attempt that has since finished or changed.
          disabled={!status.canLaunch || refresh.reloading || !!refresh.error}
          onClick={() =>
            onLaunch(
              mode,
              status.resuming || !canChoose
                ? {}
                : exclusionFor(correctIds, skipped),
            )
          }
        >
          {refresh.reloading && (
            <Loader2 className="animate-spin" aria-hidden />
          )}
          {status.resuming ? "Continue" : "Start"}{" "}
          {mode === "official" ? "official quiz" : "alternative version"}{" "}
          <ArrowRight aria-hidden />
        </Button>
        {status.canLaunch && !status.resuming && (
          <span className="text-sm text-muted-foreground">
            {questionCount} question{questionCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <RecentAttempts attempts={overview.recentAttempts} />
    </div>
  );
}
