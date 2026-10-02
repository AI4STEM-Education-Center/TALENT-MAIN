import { requireStatsClass, type StatsAudience } from "@/lib/stats-access";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, BookOpen, Users, ChevronRight, Atom } from "lucide-react";
import {
  getClassStatsOverview,
  getClassSimulationInsights,
} from "@/lib/quiz-stats-server";
import { StatCard } from "@/components/teacher/stats-ui";
import { pct, ratePct } from "@/lib/stats-format";
import { formatDurationMs } from "@/lib/simulation-stats";
import { RequestConsentExportDialog } from "@/app/(dashboard)/teacher/classes/[id]/stats/request-consent-export-dialog";
import { ExportParticipationCreditDialog } from "@/app/(dashboard)/teacher/classes/[id]/stats/export-participation-credit-dialog";

const nameKey = (firstName: string, lastName: string) =>
  `${firstName.trim().toLowerCase()}|${lastName.trim().toLowerCase()}`;

const fmtDate = (d: Date | null) =>
  d
    ? new Date(d).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

export async function ClassStatsView({
  params,
  audience,
}: {
  audience: StatsAudience;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cls = await requireStatsClass(id, audience);
  const basePath = `/${audience}/classes/${id}`;

  const [{ quizzes, students }, sim] = await Promise.all([
    getClassStatsOverview(id),
    getClassSimulationInsights(id),
  ]);
  const retakeDelta =
    sim.retake.withSim.students > 0 && sim.retake.withoutSim.students > 0
      ? sim.retake.withSim.meanDelta - sim.retake.withoutSim.meanDelta
      : null;
  const activityByName = new Map(
    students.map((student) => [
      nameKey(student.firstName, student.lastName),
      student,
    ]),
  );
  const activityByEmail = new Map(
    students.map((student) => [student.email.trim().toLowerCase(), student]),
  );
  const participationRows = cls.studentList.map((student) => {
    const rosterEmail = student.email.trim().toLowerCase();
    const activity =
      (rosterEmail ? activityByEmail.get(rosterEmail) : undefined) ??
      activityByName.get(nameKey(student.firstName, student.lastName));
    return {
      orgDefinedId: student.orgDefinedId,
      firstName: student.firstName,
      lastName: student.lastName,
      quizzesCompleted: activity?.quizzesCompleted ?? 0,
      completedAttempts: activity?.totalAttempts ?? 0,
    };
  });

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={audience === "admin" ? "/admin/classes" : basePath}>
          <ArrowLeft className="size-4" /> Back to class
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{cls.name} — Statistics</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Per-quiz and per-student performance. Click any row for the full
            breakdown.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {audience === "teacher" && (
            <RequestConsentExportDialog classId={id} />
          )}
          {audience === "admin" && (
            <Button variant="outline" asChild>
              <Link href={`/admin/usage?classId=${id}`}>
                Student usage records
              </Link>
            </Button>
          )}
          <ExportParticipationCreditDialog
            className={cls.name}
            rows={participationRows}
          />
        </div>
      </div>

      {/* Simulation engagement summary — client-reported telemetry, so these
          are engagement signals; the retake comparison is correlation only. */}
      {sim.totalSessions > 0 && (
        <div className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <Atom className="size-4" /> Simulation engagement
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Students exploring"
              value={`${sim.studentsWithSessions}`}
              sub={
                sim.studentsAttempted > 0
                  ? `of ${sim.studentsAttempted} who attempted a quiz`
                  : undefined
              }
            />
            <StatCard label="Sessions" value={`${sim.totalSessions}`} />
            <StatCard
              label="Median active time"
              value={formatDurationMs(sim.medianActiveMs)}
              sub="per session"
            />
            <StatCard
              label="Retake improvement"
              value={
                retakeDelta === null
                  ? "—"
                  : `${retakeDelta >= 0 ? "+" : ""}${Math.round(retakeDelta)} pts`
              }
              sub={
                retakeDelta === null
                  ? "needs retakers with and without simulation use"
                  : `with sims (${sim.retake.withSim.students}) vs without (${sim.retake.withoutSim.students}) — correlation, not causation`
              }
            />
          </div>
        </div>
      )}

      {/* Quizzes table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="size-4" /> Quizzes
          </CardTitle>
        </CardHeader>
        <CardContent>
          {quizzes.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No quizzes assigned to this class.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Quiz</th>
                    <th className="py-2 px-3 font-medium text-right">
                      Students
                    </th>
                    <th className="py-2 px-3 font-medium text-right">Mean</th>
                    <th className="py-2 px-3 font-medium text-right">Median</th>
                    <th className="py-2 px-3 font-medium text-right">
                      Pass rate
                    </th>
                    <th className="py-2 px-3 font-medium text-right">
                      Avg retakes
                    </th>
                    <th className="py-2 pl-3" />
                  </tr>
                </thead>
                <tbody>
                  {quizzes.map((q) => (
                    <tr
                      key={q.quizId}
                      className="border-b last:border-0 hover:bg-muted/30"
                    >
                      <td className="py-2 pr-3">
                        <Link
                          href={`${basePath}/quizzes/${q.quizId}/stats`}
                          className="font-medium text-primary hover:underline"
                        >
                          {q.quizName}
                        </Link>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {q.studentsAttempted}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {q.studentsAttempted > 0 ? pct(q.mean) : "—"}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {q.studentsAttempted > 0 ? pct(q.median) : "—"}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {q.studentsAttempted > 0 ? ratePct(q.passRate) : "—"}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {q.studentsAttempted > 0
                          ? q.avgAttemptsPerStudent.toFixed(1)
                          : "—"}
                      </td>
                      <td className="py-2 pl-3 text-right">
                        <Link
                          href={`${basePath}/quizzes/${q.quizId}/stats`}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRight className="size-4 inline" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Students table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" /> Students
          </CardTitle>
        </CardHeader>
        <CardContent>
          {students.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No students enrolled yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Student</th>
                    <th className="py-2 px-3 font-medium text-right">
                      Quizzes done
                    </th>
                    <th className="py-2 px-3 font-medium text-right">
                      Avg best
                    </th>
                    <th className="py-2 px-3 font-medium text-right">
                      Attempts
                    </th>
                    <th className="py-2 px-3 font-medium text-right">
                      Last activity
                    </th>
                    <th className="py-2 pl-3" />
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr
                      key={s.studentId}
                      className="border-b last:border-0 hover:bg-muted/30"
                    >
                      <td className="py-2 pr-3">
                        <Link
                          href={`${basePath}/students/${s.studentId}/stats`}
                          className="font-medium text-primary hover:underline"
                        >
                          {s.name}
                        </Link>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {s.quizzesCompleted}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {s.quizzesCompleted > 0 ? pct(s.avgBestScore) : "—"}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {s.totalAttempts}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">
                        {fmtDate(s.lastActivity)}
                      </td>
                      <td className="py-2 pl-3 text-right">
                        <Link
                          href={`${basePath}/students/${s.studentId}/stats`}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRight className="size-4 inline" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
