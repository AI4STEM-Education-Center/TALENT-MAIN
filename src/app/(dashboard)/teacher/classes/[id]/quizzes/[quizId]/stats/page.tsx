import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Atom } from "lucide-react";
import { getQuizStats, getQuizSimulationStats } from "@/lib/quiz-stats-server";
import { StatCard, DistributionBars, RateBar } from "@/components/teacher/stats-ui";
import { pct, ratePct } from "@/lib/stats-format";
import { MathText } from "@/components/ui/math-text";
import { formatDurationMs } from "@/lib/simulation-stats";
import { ExportGradesDialog } from "./export-grades-dialog";
import { ManualGradesTable } from "./manual-grades-table";

export default async function QuizStatsPage({
  params,
}: {
  params: Promise<{ id: string; quizId: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");
  const { id, quizId } = await params;

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const cls = await prisma.class.findFirst({ where: { id, teacherId: teacher?.id ?? "" } });
  if (!cls) notFound();

  const [stats, simStats] = await Promise.all([
    getQuizStats(id, quizId),
    getQuizSimulationStats(id, quizId),
  ]);
  if (!stats) notFound();

  const hasData = stats.studentsAttempted > 0;

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/teacher/classes/${id}/stats`}><ArrowLeft className="size-4" /> Class statistics</Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{stats.quizName}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {stats.studentsAttempted} student{stats.studentsAttempted !== 1 ? "s" : ""} · {stats.attemptsTotal} attempt{stats.attemptsTotal !== 1 ? "s" : ""}
          </p>
        </div>
        <ExportGradesDialog classId={id} quizId={quizId} quizName={stats.quizName} />
      </div>

      {!hasData ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            No completed attempts yet.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Mean" value={pct(stats.mean)} />
            <StatCard label="Median" value={pct(stats.median)} />
            <StatCard label="Pass rate" value={ratePct(stats.passRate)} sub="best ≥ 60%" />
            <StatCard label="Avg retakes" value={stats.avgAttemptsPerStudent.toFixed(1)} sub="per student" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Score distribution</CardTitle></CardHeader>
              <CardContent>
                <DistributionBars buckets={stats.distribution} />
                <p className="mt-3 text-xs text-muted-foreground">
                  Range {pct(stats.min)}–{pct(stats.max)} (best score per student).
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Per-question correctness</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {stats.questionStats.length === 0 ? (
                  <p className="text-sm text-muted-foreground">This quiz has no questions.</p>
                ) : (
                  stats.questionStats.map((q, i) => (
                    <RateBar
                      key={q.questionId}
                      label={<>{i + 1}. <MathText text={q.text} /></>}
                      rate={q.rate}
                      caption={`${q.correct}/${q.total} correct`}
                    />
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          {/* Simulation engagement — from client-reported SimulationSession
              telemetry, so numbers are engagement signal rather than exact. */}
          {simStats.engagement.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Atom className="size-4" /> Simulation engagement
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-xs text-muted-foreground">
                  {simStats.uniqueStudents} student{simStats.uniqueStudents !== 1 ? "s" : ""} opened
                  a simulation from their results, {simStats.totalSessions} session
                  {simStats.totalSessions !== 1 ? "s" : ""} total.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-3 font-medium">Simulation</th>
                        <th className="py-2 px-3 font-medium text-right">Students</th>
                        <th className="py-2 px-3 font-medium text-right">Sessions</th>
                        <th className="py-2 px-3 font-medium text-right">Median active</th>
                        <th className="py-2 px-3 font-medium text-right">Avg changes</th>
                        <th className="py-2 px-3 font-medium text-right">Bounce</th>
                      </tr>
                    </thead>
                    <tbody>
                      {simStats.engagement.map((row) => (
                        <tr key={row.simulationId} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="py-2 pr-3">{row.title}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{row.uniqueStudents}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{row.sessions}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{formatDurationMs(row.medianActiveMs)}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{row.meanParamChanges.toFixed(1)}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{ratePct(row.bounceRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Bounce = sessions under 10s of activity or with no interaction.
                </p>
              </CardContent>
            </Card>
          )}

        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Student grades</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            Manual percentages override calculated grades for this test in every export.
          </p>
          <ManualGradesTable
            classId={id}
            quizId={quizId}
            initialStudents={stats.students}
          />
        </CardContent>
      </Card>
    </div>
  );
}
