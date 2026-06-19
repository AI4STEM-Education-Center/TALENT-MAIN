import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, BookOpen, Users, ChevronRight } from "lucide-react";
import { getClassStatsOverview } from "@/lib/quiz-stats-server";
import { pct, ratePct } from "@/components/teacher/stats-ui";

const fmtDate = (d: Date | null) =>
  d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

export default async function ClassStatsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");
  const { id } = await params;

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const cls = await prisma.class.findFirst({ where: { id, teacherId: teacher?.id ?? "" } });
  if (!cls) notFound();

  const { quizzes, students } = await getClassStatsOverview(id);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/teacher/classes/${id}`}><ArrowLeft className="size-4" /> Back to class</Link>
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{cls.name} — Statistics</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Per-quiz and per-student performance. Click any row for the full breakdown.
        </p>
      </div>

      {/* Quizzes table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><BookOpen className="size-4" /> Quizzes</CardTitle>
        </CardHeader>
        <CardContent>
          {quizzes.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No quizzes assigned to this class.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Quiz</th>
                    <th className="py-2 px-3 font-medium text-right">Students</th>
                    <th className="py-2 px-3 font-medium text-right">Mean</th>
                    <th className="py-2 px-3 font-medium text-right">Median</th>
                    <th className="py-2 px-3 font-medium text-right">Pass rate</th>
                    <th className="py-2 px-3 font-medium text-right">Avg retakes</th>
                    <th className="py-2 pl-3" />
                  </tr>
                </thead>
                <tbody>
                  {quizzes.map((q) => (
                    <tr key={q.quizId} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 pr-3">
                        <Link href={`/teacher/classes/${id}/quizzes/${q.quizId}/stats`} className="font-medium text-primary hover:underline">
                          {q.quizName}
                        </Link>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">{q.studentsAttempted}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{q.studentsAttempted > 0 ? pct(q.mean) : "—"}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{q.studentsAttempted > 0 ? pct(q.median) : "—"}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{q.studentsAttempted > 0 ? ratePct(q.passRate) : "—"}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{q.studentsAttempted > 0 ? q.avgAttemptsPerStudent.toFixed(1) : "—"}</td>
                      <td className="py-2 pl-3 text-right">
                        <Link href={`/teacher/classes/${id}/quizzes/${q.quizId}/stats`} className="text-muted-foreground hover:text-foreground">
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
          <CardTitle className="flex items-center gap-2 text-base"><Users className="size-4" /> Students</CardTitle>
        </CardHeader>
        <CardContent>
          {students.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No students enrolled yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Student</th>
                    <th className="py-2 px-3 font-medium text-right">Quizzes done</th>
                    <th className="py-2 px-3 font-medium text-right">Avg best</th>
                    <th className="py-2 px-3 font-medium text-right">Attempts</th>
                    <th className="py-2 px-3 font-medium text-right">Last activity</th>
                    <th className="py-2 pl-3" />
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr key={s.studentId} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 pr-3">
                        <Link href={`/teacher/classes/${id}/students/${s.studentId}/stats`} className="font-medium text-primary hover:underline">
                          {s.name}
                        </Link>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">{s.quizzesCompleted}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{s.quizzesCompleted > 0 ? pct(s.avgBestScore) : "—"}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{s.totalAttempts}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{fmtDate(s.lastActivity)}</td>
                      <td className="py-2 pl-3 text-right">
                        <Link href={`/teacher/classes/${id}/students/${s.studentId}/stats`} className="text-muted-foreground hover:text-foreground">
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
