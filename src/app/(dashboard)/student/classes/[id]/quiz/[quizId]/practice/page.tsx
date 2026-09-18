"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { QuizPlayer } from "@/components/quiz/QuizPlayer";
import { Button } from "@/components/ui/button";

type PracticeHistory = {
  available: number;
  attempts: {
    id: string;
    versionName: string;
    score: number | null;
    completedAt: string | null;
    startedAt: string;
  }[];
};
export default function PracticePage() {
  const { id: classId, quizId } = useParams<{ id: string; quizId: string }>();
  const [history, setHistory] = useState<PracticeHistory | null>(null);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);
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
        objectives. These attempts do not change your grade or use your graded
        attempt allowance.
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
          <h2 className="font-semibold">Practice history</h2>
          {!history.attempts.length && <p>No practice attempts yet.</p>}
          <ul className="space-y-2">
            {history.attempts.map((a) => (
              <li key={a.id} className="border rounded p-3">
                {a.versionName} ·{" "}
                {a.completedAt ? `${Math.round(a.score ?? 0)}%` : "In progress"}
                <span className="block text-sm text-muted-foreground">
                  {new Date(a.startedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
