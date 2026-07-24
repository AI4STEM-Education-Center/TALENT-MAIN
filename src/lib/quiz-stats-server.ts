// Impure server-side aggregation for the teacher statistics pages + APIs. All
// Prisma access for stats is concentrated here; the pure math lives in
// `quiz-stats.ts`. Callers (API routes + server pages) must verify class
// ownership before calling — these functions assume the (classId, …) is
// already authorized.

import { prisma } from "./prisma";
import {
  mean,
  median,
  min,
  max,
  passRate,
  averageAttemptsPerStudent,
  scoreDistribution,
  PASS_THRESHOLD,
  type DistributionBucket,
} from "./quiz-stats";
import {
  summarizeSimulationEngagement,
  retakeImprovementBySimUse,
  type SimulationEngagementRow,
  type RetakeImpact,
} from "./simulation-stats";

const fullName = (u: { firstName: string; lastName: string }): string =>
  [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || "Unknown student";

// ─── Per-quiz stats ──────────────────────────────────────────────────────────

export type QuizStudentRow = {
  studentId: string;
  name: string;
  bestScore: number;
  attempts: number;
};

export type QuestionStat = {
  questionId: string;
  text: string;
  total: number;
  correct: number;
  rate: number; // 0-1
};

export type QuizStats = {
  quizId: string;
  quizName: string;
  attemptsTotal: number;
  studentsAttempted: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  passRate: number; // 0-1, on best scores
  avgAttemptsPerStudent: number;
  distribution: DistributionBucket[];
  questionStats: QuestionStat[];
  students: QuizStudentRow[];
};

/**
 * Per-quiz statistics for one class: per-student best score + attempt count,
 * aggregate score stats over best scores, pass rate, avg retakes, the score
 * distribution, and per-question correctness rates. Returns null if the quiz is
 * gone.
 */
export async function getQuizStats(classId: string, quizId: string): Promise<QuizStats | null> {
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId }, select: { name: true } });
  if (!quiz) return null;

  const [attempts, questions, grouped] = await Promise.all([
    prisma.quizAttempt.findMany({
      where: { classId, quizId, completedAt: { not: null } },
      select: {
        studentId: true,
        score: true,
        student: { select: { user: { select: { firstName: true, lastName: true } } } },
      },
    }),
    prisma.question.findMany({
      where: { quizId },
      select: { id: true, text: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.quizAnswer.groupBy({
      by: ["questionId", "isCorrect"],
      where: { quizAttempt: { classId, quizId, completedAt: { not: null } } },
      _count: { _all: true },
    }),
  ]);

  // Collapse attempts into one row per student (best score + attempt count).
  const byStudent = new Map<string, { name: string; scores: number[]; attempts: number }>();
  for (const a of attempts) {
    const row = byStudent.get(a.studentId) ?? { name: fullName(a.student.user), scores: [], attempts: 0 };
    row.scores.push(a.score ?? 0);
    row.attempts += 1;
    byStudent.set(a.studentId, row);
  }
  const students: QuizStudentRow[] = [...byStudent.entries()]
    .map(([studentId, v]) => ({ studentId, name: v.name, bestScore: max(v.scores), attempts: v.attempts }))
    .toSorted((a, b) => b.bestScore - a.bestScore);

  const bestScores = students.map((s) => s.bestScore);
  const attemptCounts = students.map((s) => s.attempts);

  // Per-question correctness: fold the (questionId, isCorrect) groups into
  // correct/total counts, then join the live question text.
  const counts = new Map<string, { correct: number; total: number }>();
  for (const g of grouped) {
    const c = counts.get(g.questionId) ?? { correct: 0, total: 0 };
    c.total += g._count._all;
    if (g.isCorrect) c.correct += g._count._all;
    counts.set(g.questionId, c);
  }
  const questionStats: QuestionStat[] = questions.map((q) => {
    const c = counts.get(q.id) ?? { correct: 0, total: 0 };
    return {
      questionId: q.id,
      text: q.text,
      total: c.total,
      correct: c.correct,
      rate: c.total > 0 ? c.correct / c.total : 0,
    };
  });

  return {
    quizId,
    quizName: quiz.name,
    attemptsTotal: attempts.length,
    studentsAttempted: students.length,
    mean: mean(bestScores),
    median: median(bestScores),
    min: min(bestScores),
    max: max(bestScores),
    passRate: passRate(bestScores, PASS_THRESHOLD),
    avgAttemptsPerStudent: averageAttemptsPerStudent(attemptCounts),
    distribution: scoreDistribution(bestScores),
    questionStats,
    students,
  };
}

// ─── Per-student stats ───────────────────────────────────────────────────────

export type StudentQuizBreakdown = {
  quizId: string;
  quizName: string;
  bestScore: number | null;
  latestScore: number | null;
  attempts: number;
};

export type StudentAttemptRow = {
  attemptId: string; // QuizAttempt id (also the ExamResult.quizAttemptId for drill-down)
  quizId: string | null;
  quizName: string;
  score: number;
  completedAt: Date;
};

export type StudentStats = {
  studentId: string;
  studentName: string;
  quizzesAssigned: number;
  quizzesCompleted: number;
  overallMean: number; // mean of all completed attempt scores
  avgBestScore: number; // mean of per-quiz best scores
  totalAttempts: number;
  avgAttemptsPerQuiz: number; // avg retakes across completed quizzes
  lastActivity: Date | null;
  perQuiz: StudentQuizBreakdown[];
  attempts: StudentAttemptRow[];
};

/**
 * Cross-quiz statistics for one student in one class: quizzes assigned vs.
 * completed, overall + avg-best scores, total/avg attempts, last activity, a
 * per-quiz breakdown, and the flat list of completed attempts (each carrying
 * its attemptId for drill-down). Returns null if the student is gone.
 */
export async function getStudentStats(classId: string, studentId: string): Promise<StudentStats | null> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { user: { select: { firstName: true, lastName: true } } },
  });
  if (!student) return null;

  const [classQuizzes, attempts] = await Promise.all([
    prisma.classQuiz.findMany({
      where: { classId },
      select: { quizId: true, quiz: { select: { name: true } } },
      orderBy: [{ quiz: { order: "asc" } }, { quiz: { createdAt: "asc" } }],
    }),
    prisma.quizAttempt.findMany({
      where: { classId, studentId, completedAt: { not: null } },
      select: {
        id: true,
        quizId: true,
        score: true,
        completedAt: true,
        quiz: { select: { name: true } },
      },
      orderBy: { completedAt: "desc" },
    }),
  ]);

  // Group attempts by quiz to compute per-quiz best/latest/count. Attempts are
  // already newest-first, so the first seen per quiz is the latest.
  const byQuiz = new Map<string, { scores: number[]; latest: number; attempts: number }>();
  for (const a of attempts) {
    if (!a.quizId) continue;
    const row = byQuiz.get(a.quizId);
    if (row) {
      row.scores.push(a.score ?? 0);
      row.attempts += 1;
    } else {
      byQuiz.set(a.quizId, { scores: [a.score ?? 0], latest: a.score ?? 0, attempts: 1 });
    }
  }

  const perQuiz: StudentQuizBreakdown[] = classQuizzes.map((cq) => {
    const row = byQuiz.get(cq.quizId);
    return {
      quizId: cq.quizId,
      quizName: cq.quiz.name,
      bestScore: row ? max(row.scores) : null,
      latestScore: row ? row.latest : null,
      attempts: row ? row.attempts : 0,
    };
  });

  const allScores = attempts.map((a) => a.score ?? 0);
  const bestScores = [...byQuiz.values()].map((r) => max(r.scores));
  const completedQuizCount = byQuiz.size;

  const attemptRows: StudentAttemptRow[] = attempts.map((a) => ({
    attemptId: a.id,
    quizId: a.quizId,
    quizName: a.quiz?.name ?? "Removed quiz",
    score: a.score ?? 0,
    completedAt: a.completedAt!,
  }));

  return {
    studentId,
    studentName: fullName(student.user),
    quizzesAssigned: classQuizzes.length,
    quizzesCompleted: completedQuizCount,
    overallMean: mean(allScores),
    avgBestScore: mean(bestScores),
    totalAttempts: attempts.length,
    avgAttemptsPerQuiz: completedQuizCount > 0 ? attempts.length / completedQuizCount : 0,
    lastActivity: attemptRows[0]?.completedAt ?? null,
    perQuiz,
    attempts: attemptRows,
  };
}

// ─── Class overview (quizzes + students summary tables) ──────────────────────

export type ClassQuizSummary = {
  quizId: string;
  quizName: string;
  attemptsTotal: number;
  studentsAttempted: number;
  mean: number;
  median: number;
  passRate: number;
  avgAttemptsPerStudent: number;
};

export type ClassStudentSummary = {
  studentId: string;
  name: string;
  quizzesCompleted: number;
  avgBestScore: number;
  totalAttempts: number;
  lastActivity: Date | null;
};

export type ClassStatsOverview = {
  quizzes: ClassQuizSummary[];
  students: ClassStudentSummary[];
};

/**
 * Overview tables for the class stats landing page: a per-quiz summary row and a
 * per-enrolled-student summary row, computed from all completed attempts in the
 * class in a single pass (no N+1 per quiz/student).
 */
export async function getClassStatsOverview(classId: string): Promise<ClassStatsOverview> {
  const [classQuizzes, enrollments, attempts] = await Promise.all([
    prisma.classQuiz.findMany({
      where: { classId },
      select: { quizId: true, quiz: { select: { name: true } } },
      orderBy: [{ quiz: { order: "asc" } }, { quiz: { createdAt: "asc" } }],
    }),
    prisma.classEnrollment.findMany({
      where: { classId },
      select: { studentId: true, student: { select: { user: { select: { firstName: true, lastName: true } } } } },
    }),
    prisma.quizAttempt.findMany({
      where: { classId, completedAt: { not: null } },
      select: { studentId: true, quizId: true, score: true, completedAt: true },
    }),
  ]);

  // Per-quiz: best score per student, attempt count, distinct students.
  const quizzes: ClassQuizSummary[] = classQuizzes.map((cq) => {
    const quizAttempts = attempts.filter((a) => a.quizId === cq.quizId);
    const byStudent = new Map<string, number[]>();
    for (const a of quizAttempts) {
      const arr = byStudent.get(a.studentId) ?? [];
      arr.push(a.score ?? 0);
      byStudent.set(a.studentId, arr);
    }
    const bestScores = [...byStudent.values()].map((s) => max(s));
    const attemptCounts = [...byStudent.values()].map((s) => s.length);
    return {
      quizId: cq.quizId,
      quizName: cq.quiz.name,
      attemptsTotal: quizAttempts.length,
      studentsAttempted: byStudent.size,
      mean: mean(bestScores),
      median: median(bestScores),
      passRate: passRate(bestScores, PASS_THRESHOLD),
      avgAttemptsPerStudent: averageAttemptsPerStudent(attemptCounts),
    };
  });

  // Per-student: across all quizzes — best score per quiz, total attempts, last activity.
  const students: ClassStudentSummary[] = enrollments.map((e) => {
    const studentAttempts = attempts.filter((a) => a.studentId === e.studentId);
    const byQuiz = new Map<string, number[]>();
    let lastActivity: Date | null = null;
    for (const a of studentAttempts) {
      if (a.completedAt && (!lastActivity || a.completedAt > lastActivity)) lastActivity = a.completedAt;
      if (!a.quizId) continue;
      const arr = byQuiz.get(a.quizId) ?? [];
      arr.push(a.score ?? 0);
      byQuiz.set(a.quizId, arr);
    }
    const bestScores = [...byQuiz.values()].map((s) => max(s));
    return {
      studentId: e.studentId,
      name: fullName(e.student.user),
      quizzesCompleted: byQuiz.size,
      avgBestScore: mean(bestScores),
      totalAttempts: studentAttempts.length,
      lastActivity,
    };
  });

  return { quizzes, students };
}

// ─── Simulation engagement ───────────────────────────────────────────────────

const SESSION_SELECT = {
  simulationId: true,
  studentId: true,
  quizId: true,
  startedAt: true,
  activeMs: true,
  interactionCount: true,
  paramChanges: true,
} as const;

/** Display titles for a set of simulation ids (fallback handled by the caller). */
async function simulationTitles(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const sims = await prisma.questionSimulation.findMany({
    where: { id: { in: unique } },
    select: { id: true, title: true, topic: true },
  });
  return new Map(sims.map((s) => [s.id, s.title ?? s.topic ?? "Interactive simulation"]));
}

export type QuizSimulationStats = {
  totalSessions: number;
  uniqueStudents: number;
  engagement: SimulationEngagementRow[];
};

/** Per-quiz simulation engagement for one class: one row per simulation. */
export async function getQuizSimulationStats(
  classId: string,
  quizId: string
): Promise<QuizSimulationStats> {
  const sessions = await prisma.simulationSession.findMany({
    where: { classId, quizId },
    select: SESSION_SELECT,
  });
  const titles = await simulationTitles(sessions.map((s) => s.simulationId));
  return {
    totalSessions: sessions.length,
    uniqueStudents: new Set(sessions.map((s) => s.studentId)).size,
    engagement: summarizeSimulationEngagement(sessions, titles),
  };
}

export type ClassSimulationInsights = {
  totalSessions: number;
  studentsWithSessions: number;
  studentsAttempted: number;
  medianActiveMs: number;
  retake: RetakeImpact;
};

/**
 * Class-level simulation insights: adoption (students with any session vs.
 * students who attempted a quiz), median active time, and the retake-
 * improvement split by simulation use. Correlation only — the UI labels it so.
 */
export async function getClassSimulationInsights(classId: string): Promise<ClassSimulationInsights> {
  const [sessions, attempts] = await Promise.all([
    prisma.simulationSession.findMany({ where: { classId }, select: SESSION_SELECT }),
    prisma.quizAttempt.findMany({
      where: { classId, completedAt: { not: null } },
      select: { studentId: true, quizId: true, score: true, completedAt: true },
    }),
  ]);
  return {
    totalSessions: sessions.length,
    studentsWithSessions: new Set(sessions.map((s) => s.studentId)).size,
    studentsAttempted: new Set(attempts.map((a) => a.studentId)).size,
    medianActiveMs: median(sessions.map((s) => s.activeMs)),
    retake: retakeImprovementBySimUse(attempts, sessions),
  };
}

export type StudentSimulationSessionRow = {
  sessionId: string;
  title: string;
  quizName: string | null;
  surface: string;
  startedAt: Date;
  activeMs: number;
  paramChanges: number;
};

/** A student's recent simulation sessions in one class, newest first. */
export async function getStudentSimulationSessions(
  classId: string,
  studentId: string,
  limit = 50
): Promise<StudentSimulationSessionRow[]> {
  const sessions = await prisma.simulationSession.findMany({
    where: { classId, studentId },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  const [titles, quizzes] = await Promise.all([
    simulationTitles(sessions.map((s) => s.simulationId)),
    prisma.quiz.findMany({
      where: { id: { in: [...new Set(sessions.flatMap((s) => (s.quizId ? [s.quizId] : [])))] } },
      select: { id: true, name: true },
    }),
  ]);
  const quizNames = new Map(quizzes.map((q) => [q.id, q.name]));
  return sessions.map((s) => ({
    sessionId: s.id,
    title: titles.get(s.simulationId) ?? "Removed simulation",
    quizName: s.quizId ? (quizNames.get(s.quizId) ?? null) : null,
    surface: s.surface,
    startedAt: s.startedAt,
    activeMs: s.activeMs,
    paramChanges: s.paramChanges,
  }));
}
