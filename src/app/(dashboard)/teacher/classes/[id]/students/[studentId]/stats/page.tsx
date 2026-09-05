import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ChevronRight, Atom } from "lucide-react";
import {
  getStudentStats,
  getStudentSimulationSessions,
} from "@/lib/quiz-stats-server";
import { StatCard } from "@/components/teacher/stats-ui";
import { pct } from "@/lib/stats-format";
import { formatDurationMs } from "@/lib/simulation-stats";

const fmtDateTime = (d: Date | null) =>
  d
    ? new Date(d).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

export default async function StudentStatsPage({
  params,
}: {
  params: Promise<{ id: string; studentId: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");
  const { id, studentId } = await params;

  const teacher = await prisma.teacher.findUnique({
    where: { userId: session.user.id },
  });
  const cls = await prisma.class.findFirst({
    where: { id, teacherId: teacher?.id ?? "" },
  });
  if (!cls) notFound();

  // The student must be enrolled in this class.
  const enrollment = await prisma.classEnrollment.findUnique({
    where: { classId_studentId: { classId: id, studentId } },
  });
  if (!enrollment) notFound();

  const [stats, simSessions] = await Promise.all([
    getStudentStats(id, studentId),
    getStudentSimulationSessions(id, studentId),
  ]);
  if (!stats) notFound();

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/teacher/classes/${id}/stats`}>
          <ArrowLeft className="size-4" /> Class statistics
        </Link>
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{stats.studentName}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {stats.quizzesCompleted}/{stats.quizzesAssigned} quizzes completed ·
          last active {fmtDateTime(stats.lastActivity)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Avg best score"
          value={stats.quizzesCompleted > 0 ? pct(stats.avgBestScore) : "—"}
        />
        <StatCard
          label="Overall mean"
          value={stats.totalAttempts > 0 ? pct(stats.overallMean) : "—"}
          sub="all attempts"
        />
        <StatCard label="Total attempts" value={String(stats.totalAttempts)} />
        <StatCard
          label="Avg retakes"
          value={
            stats.quizzesCompleted > 0
              ? stats.avgAttemptsPerQuiz.toFixed(1)
              : "—"
          }
          sub="per quiz"
        />
      </div>

      {/* Per-quiz breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-quiz breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Quiz</th>
                  <th className="py-2 px-3 font-medium text-right">Best</th>
                  <th className="py-2 px-3 font-medium text-right">Latest</th>
                  <th className="py-2 px-3 font-medium text-right">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {stats.perQuiz.map((q) => (
                  <tr key={q.quizId} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">
                      <Link
                        href={`/teacher/classes/${id}/quizzes/${q.quizId}/stats`}
                        className="text-primary hover:underline"
                      >
                        {q.quizName}
                      </Link>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {q.bestScore != null ? pct(q.bestScore) : "—"}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {q.latestScore != null ? pct(q.latestScore) : "—"}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {q.attempts}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Simulations this student explored (client-reported telemetry). */}
      {simSessions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Atom className="size-4" /> Simulations explored
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Simulation</th>
                    <th className="py-2 px-3 font-medium">Quiz</th>
                    <th className="py-2 px-3 font-medium text-right">
                      Active time
                    </th>
                    <th className="py-2 px-3 font-medium text-right">
                      Param changes
                    </th>
                    <th className="py-2 px-3 font-medium text-right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {simSessions.map((s) => (
                    <tr key={s.sessionId} className="border-b last:border-0">
                      <td className="py-2 pr-3">{s.title}</td>
                      <td className="py-2 px-3 text-muted-foreground">
                        {s.quizName ?? "—"}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {formatDurationMs(s.activeMs)}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {s.paramChanges}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                        {fmtDateTime(s.startedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Individual attempts (drill into full per-question detail) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attempts</CardTitle>
        </CardHeader>
        <CardContent>
          {stats.attempts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No completed attempts yet.
            </p>
          ) : (
            <div className="space-y-2">
              {stats.attempts.map((a) => (
                <Link
                  key={a.attemptId}
                  href={`/teacher/classes/${id}/students/${studentId}/attempts/${a.attemptId}`}
                  className="flex items-center justify-between gap-2 rounded-lg border p-3 hover:bg-muted/30"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{a.quizName}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtDateTime(a.completedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-sm font-semibold tabular-nums">
                      {pct(a.score)}
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
