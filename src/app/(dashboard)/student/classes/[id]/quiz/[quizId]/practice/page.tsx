"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { QuizPlayer } from "@/components/quiz/QuizPlayer";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format-date";

type PracticeHistory = {
  available: number;
  /** Results on the quiz's questions so far; null before the first attempt. */
  last: { total: number; correct: number } | null;
  attempts: {
    id: string;
    quizAttemptId: string | null;
    versionName: string;
    score: number | null;
    completedAt: string | null;
    startedAt: string;
  }[];
};
type Last = NonNullable<PracticeHistory["last"]>;
const canExclude = (last: Last | null): boolean =>
  !!last && last.correct > 0 && last.correct < last.total;

function ExcludeOption({
  last,
  exclude,
  onChange,
}: {
  last: Last;
  exclude: boolean;
  onChange: (value: boolean) => void;
}) {
  if (last.total > 0 && last.correct === last.total)
    return (
      <p className="text-sm text-muted-foreground">
        You answered every question correctly last time, so the full alternative
        version will be used.
      </p>
    );
  if (!canExclude(last)) return null;
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={exclude}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        Skip the {last.correct} question{last.correct === 1 ? "" : "s"} I
        answered correctly last time and practice only the{" "}
        {last.total - last.correct} I missed.
        <span className="block text-xs text-muted-foreground">
          Your score will cover only the questions you practice.
        </span>
      </span>
    </label>
  );
}

function HistoryList({ attempts }: { attempts: PracticeHistory["attempts"] }) {
  return (
    <>
      <h2 className="font-semibold">Practice history</h2>
      {!attempts.length && <p>No practice attempts yet.</p>}
      <ul className="space-y-2">
        {attempts.map((a) => (
          <li key={a.id} className="border rounded p-3">
            {a.versionName} ·{" "}
            {a.completedAt ? `${Math.round(a.score ?? 0)}%` : "In progress"}
            {a.completedAt && a.quizAttemptId && (
              <>
                {" "}
                ·{" "}
                <Link
                  href={`/student/results/${a.quizAttemptId}`}
                  className="text-primary hover:underline"
                >
                  Results and recommendations
                </Link>
              </>
            )}
            <span className="block text-sm text-muted-foreground">
              {formatDateTime(a.startedAt)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function PracticePage() {
  const { id: classId, quizId } = useParams<{ id: string; quizId: string }>();
  const [history, setHistory] = useState<PracticeHistory | null>(null);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);
  // null = untouched, so the default follows the loaded history.
  const [excludeChoice, setExcludeChoice] = useState<boolean | null>(null);
  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(
        `/api/quiz/practice?${new URLSearchParams({ classId, quizId })}`,
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not load practice.");
      setHistory(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load practice.");
    }
  }, [classId, quizId]);
  useEffect(() => {
    void load();
  }, [load]);
  const backHref = `/student/classes/${classId}`;
  const inProgress = !!history?.attempts.some((a) => !a.completedAt);
  const last = history?.last ?? null;
  // Default on when there is something to leave out and something left to ask.
  const exclude = canExclude(last) && (excludeChoice ?? true);
  if (started)
    return (
      <>
        <div className="px-4 pt-4 md:px-6">
          <Button
            variant="outline"
            onClick={() => {
              setStarted(false);
              void load();
            }}
          >
            Practice history
          </Button>
        </div>
        <QuizPlayer
          mode="practice"
          quizId={quizId}
          classId={classId}
          excludeCorrect={exclude && !inProgress}
          onPracticeAgain={() => {
            setStarted(false);
            void load();
          }}
          backHref={backHref}
          backLabel="Back to class"
        />
      </>
    );
  return (
    <div className="p-4 md:p-6 max-w-2xl space-y-4">
      <Button variant="ghost" asChild>
        <Link href={backHref}>Back to class</Link>
      </Button>
      <h1 className="text-xl font-semibold">Practice another version</h1>
      <p>
        Try teacher-approved alternatives that assess the same learning
        objectives. Each one is recorded as a retake in your exam history with
        its own results and study recommendations. It does not change your
        graded score or use your graded attempt allowance.
      </p>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={() => void load()}>
            Reload
          </Button>
        </div>
      )}
      {!history && !error && <p role="status">Loading practice…</p>}
      {history && (
        <>
          {!inProgress && last && (
            <ExcludeOption
              last={last}
              exclude={exclude}
              onChange={setExcludeChoice}
            />
          )}
          <Button
            disabled={
              !history.available &&
              !history.attempts.some((a) => !a.completedAt)
            }
            onClick={() => setStarted(true)}
          >
            {history.attempts.some((a) => !a.completedAt)
              ? "Continue practice"
              : "Start practice"}
          </Button>
          {!history.available && (
            <p className="text-sm text-muted-foreground">
              No new alternative versions are currently published.
            </p>
          )}
          <HistoryList attempts={history.attempts} />
        </>
      )}
    </div>
  );
}
