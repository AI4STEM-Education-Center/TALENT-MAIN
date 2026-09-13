// Pure aggregation helpers for the teacher-facing simulation-engagement stats.
// No DB / Next imports, so this is unit-testable like `quiz-stats.ts`; the
// Prisma assembly lives in `quiz-stats-server.ts`. All inputs are
// SimulationSession rows (client-reported, already clamped server-side) —
// treat every number here as engagement signal, not ground truth.

import { mean, median } from "./quiz-stats";

/** A session spent below this much active time (or with no interactions) "bounced". */
export const BOUNCE_ACTIVE_MS = 10_000;

/** A session with at least this much active time counts as real engagement. */
export const ENGAGED_ACTIVE_MS = 30_000;

/** The subset of SimulationSession the aggregations need. */
export type SimSessionRecord = {
  simulationId: string;
  studentId: string;
  quizId: string | null;
  startedAt: Date;
  activeMs: number;
  interactionCount: number;
  paramChanges: number;
};

/** "1h 05m" / "4m 05s" / "32s" — compact duration for stat cells. */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export type SimulationEngagementRow = {
  simulationId: string;
  title: string;
  sessions: number;
  uniqueStudents: number;
  medianActiveMs: number;
  meanParamChanges: number;
  bounceRate: number; // 0-1: sessions that never really engaged
};

const bounced = (s: SimSessionRecord): boolean =>
  s.activeMs < BOUNCE_ACTIVE_MS || s.interactionCount === 0;

/**
 * Fold sessions into one engagement row per simulation, sorted by unique
 * students (most-used first). `titles` maps simulationId → display title;
 * sessions whose simulation row is gone still aggregate under a fallback.
 */
export function summarizeSimulationEngagement(
  sessions: SimSessionRecord[],
  titles: Map<string, string>
): SimulationEngagementRow[] {
  const bySim = new Map<string, SimSessionRecord[]>();
  for (const s of sessions) {
    const arr = bySim.get(s.simulationId) ?? [];
    arr.push(s);
    bySim.set(s.simulationId, arr);
  }
  return [...bySim.entries()]
    .map(([simulationId, rows]) => ({
      simulationId,
      title: titles.get(simulationId) ?? "Removed simulation",
      sessions: rows.length,
      uniqueStudents: new Set(rows.map((r) => r.studentId)).size,
      medianActiveMs: median(rows.map((r) => r.activeMs)),
      meanParamChanges: mean(rows.map((r) => r.paramChanges)),
      bounceRate: rows.filter(bounced).length / rows.length,
    }))
    .toSorted((a, b) => b.uniqueStudents - a.uniqueStudents || b.sessions - a.sessions);
}

/** A completed quiz attempt, minimal shape for the retake-impact split. */
export type AttemptRecord = {
  studentId: string;
  quizId: string | null;
  score: number | null;
  completedAt: Date | null;
};

export type RetakeGroup = { students: number; meanDelta: number };
export type RetakeImpact = { withSim: RetakeGroup; withoutSim: RetakeGroup };

/**
 * Split retakers by simulation use and compare their improvement. For every
 * (student, quiz) with ≥2 completed attempts, the delta is best-later-score
 * minus first score. A retake counts as "with simulation" when the student had
 * an engaged session (active ≥ ENGAGED_ACTIVE_MS) on that quiz's simulations
 * AFTER the first attempt finished — the window in which the results page
 * surfaces them. Correlation, not causation; label it that way in the UI.
 */
export function retakeImprovementBySimUse(
  attempts: AttemptRecord[],
  sessions: SimSessionRecord[]
): RetakeImpact {
  type Group = { studentId: string; quizId: string; rows: { score: number; completedAt: Date }[] };
  const byStudentQuiz = new Map<string, Group>();
  for (const a of attempts) {
    if (!a.quizId || !a.completedAt) continue;
    const key = `${a.studentId}:${a.quizId}`;
    const group = byStudentQuiz.get(key) ?? { studentId: a.studentId, quizId: a.quizId, rows: [] };
    group.rows.push({ score: a.score ?? 0, completedAt: a.completedAt });
    byStudentQuiz.set(key, group);
  }

  const engagedSessions = sessions.filter(
    (s) => s.quizId !== null && s.activeMs >= ENGAGED_ACTIVE_MS
  );

  const withDeltas: number[] = [];
  const withoutDeltas: number[] = [];
  for (const { studentId, quizId, rows } of byStudentQuiz.values()) {
    if (rows.length < 2) continue;
    const ordered = rows.toSorted((a, b) => a.completedAt.getTime() - b.completedAt.getTime());
    const first = ordered[0];
    const bestLater = Math.max(...ordered.slice(1).map((r) => r.score));
    const delta = bestLater - first.score;

    const usedSim = engagedSessions.some(
      (s) => s.studentId === studentId && s.quizId === quizId && s.startedAt > first.completedAt
    );
    (usedSim ? withDeltas : withoutDeltas).push(delta);
  }

  return {
    withSim: { students: withDeltas.length, meanDelta: mean(withDeltas) },
    withoutSim: { students: withoutDeltas.length, meanDelta: mean(withoutDeltas) },
  };
}
