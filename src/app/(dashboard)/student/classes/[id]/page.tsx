import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { quizAvailability } from "@/lib/quiz-availability";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CheckCircle, Circle, PlayCircle, BookOpen, History } from "lucide-react";
import { ContactTeacherDialog } from "./contact-teacher-dialog";

export default async function StudentClassPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");
  const { id } = await params;

  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) redirect("/login");

  // Verify enrollment
  const enrollment = await prisma.classEnrollment.findUnique({
    where: { classId_studentId: { classId: id, studentId: student.id } },
  });
  if (!enrollment) notFound();

  const cls = await prisma.class.findUnique({
    where: { id },
    include: {
      teacher: { include: { user: true } },
      classQuizzes: {
        where: { published: true },
        include: { quiz: { include: { topic: true } } },
        orderBy: [{ quiz: { order: "asc" } }, { quiz: { createdAt: "asc" } }],
      },
    },
  });

  if (!cls) notFound();

  const quizzes = cls.classQuizzes.map((cq) => cq.quiz);
  // Per-class quiz settings (availability window + attempt cap) keyed by quizId.
  const settingsByQuiz = new Map(cls.classQuizzes.map((cq) => [cq.quizId, cq]));
  const quizIds = quizzes.map((q) => q.id);

  // Progress + completed-attempt counts (for the attempt cap) in parallel.
  const [progressRecords, attemptGroups] = await Promise.all([
    prisma.quizProgress.findMany({
      where: { studentId: student.id, classId: id, quizId: { in: quizIds } },
    }),
    prisma.quizAttempt.groupBy({
      by: ["quizId"],
      where: { studentId: student.id, classId: id, quizId: { in: quizIds }, completedAt: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const progressMap = new Map(progressRecords.map((p) => [p.quizId, p]));
  const attemptsByQuiz = new Map(
    attemptGroups.flatMap((g) => (g.quizId ? [[g.quizId, g._count._all]] : []))
  );
  const now = new Date();

  // Topic is an optional grouping label: quizzes with one are grouped under it,
  // the rest land in a single ungrouped section at the end.
  const groups = new Map<string, { topicName: string | null; quizzes: typeof quizzes }>();
  for (const quiz of quizzes) {
    const key = quiz.topic ? `topic:${quiz.topic.id}` : "ungrouped";
    const group = groups.get(key) ?? { topicName: quiz.topic?.name ?? null, quizzes: [] };
    group.quizzes.push(quiz);
    groups.set(key, group);
  }
  const orderedGroups = Array.from(groups.values()).toSorted((a, b) => {
    if (a.topicName === null) return 1;
    if (b.topicName === null) return -1;
    return 0;
  });

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/student"><ArrowLeft className="size-4" /> Dashboard</Link>
      </Button>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">{cls.name}</h1>
          <p className="text-muted-foreground text-sm mt-1">Teacher: {cls.teacher.user.firstName} {cls.teacher.user.lastName}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ContactTeacherDialog
            classId={id}
            teacherName={`${cls.teacher.user.firstName} ${cls.teacher.user.lastName}`.trim()}
          />
          <Button variant="outline" size="sm" asChild>
            <Link href={`/student/classes/${id}/history`}><History className="size-4" /> Exam history</Link>
          </Button>
        </div>
      </div>

      {quizzes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <BookOpen className="size-12 text-muted-foreground mb-3" />
            <p className="text-lg font-medium">No quizzes available yet</p>
            <p className="text-muted-foreground text-sm mt-1">Your teacher hasn&apos;t published any quizzes yet. Check back soon!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {orderedGroups.map((group) => {
            const completed = group.quizzes.filter((q) => progressMap.get(q.id)?.status === "COMPLETED").length;

            return (
              <Card key={group.topicName ?? "__ungrouped"}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <CardTitle className="flex items-center gap-2">
                      <BookOpen className="size-5 text-primary shrink-0" />
                      {group.topicName ?? "Quizzes"}
                    </CardTitle>
                    <Badge variant="secondary" className="shrink-0">{completed}/{group.quizzes.length} completed</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {group.quizzes.map((quiz, idx) => {
                      const progress = progressMap.get(quiz.id);
                      const status = progress?.status || "NOT_STARTED";
                      const score = progress?.bestScore;

                      // Per-class availability + attempt gating, via the shared
                      // helper so this page, POST /api/quiz, and the assistant's
                      // answer-key gate can't drift apart. Server-side
                      // enforcement in POST /api/quiz remains the source of truth.
                      const settings = settingsByQuiz.get(quiz.id);
                      const opensAt = settings?.availableFrom ? new Date(settings.availableFrom) : null;
                      const closesAt = settings?.availableUntil ? new Date(settings.availableUntil) : null;
                      const maxAttempts = settings?.maxAttempts ?? null;
                      const attemptsUsed = attemptsByQuiz.get(quiz.id) ?? 0;
                      const { notOpenYet, closed, locked } = quizAvailability(
                        { availableFrom: opensAt, availableUntil: closesAt, maxAttempts },
                        attemptsUsed,
                        now
                      );

                      const dateFmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

                      return (
                        <div key={quiz.id} className="flex items-center justify-between gap-2 p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            {status === "COMPLETED" ? (
                              <CheckCircle className="size-5 text-green-500 shrink-0" />
                            ) : status === "IN_PROGRESS" ? (
                              <PlayCircle className="size-5 text-blue-500 shrink-0" />
                            ) : (
                              <Circle className="size-5 text-muted-foreground shrink-0" />
                            )}
                            <div className="min-w-0">
                              <p className="font-medium text-sm">{idx + 1}. {quiz.name}</p>
                              {score !== null && score !== undefined && (
                                <p className="text-xs text-muted-foreground">Best score: {Math.round(score)}%</p>
                              )}
                              <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                                {notOpenYet && <span>Opens {opensAt!.toLocaleDateString(undefined, dateFmt)}</span>}
                                {closed && <span>Closed {closesAt!.toLocaleDateString(undefined, dateFmt)}</span>}
                                {maxAttempts != null && maxAttempts > 0 && (
                                  <span>Attempts {attemptsUsed}/{maxAttempts}</span>
                                )}
                              </div>
                            </div>
                          </div>
                          {locked ? (
                            <Button size="sm" variant="secondary" disabled className="shrink-0">
                              {notOpenYet ? "Not open" : closed ? "Closed" : "No attempts left"}
                            </Button>
                          ) : (
                            <Button size="sm" variant={status === "COMPLETED" ? "secondary" : "default"} asChild className="shrink-0">
                              <Link href={`/student/classes/${id}/quiz/${quiz.id}`}>
                                {status === "COMPLETED" ? "Retry" : status === "IN_PROGRESS" ? "Continue" : "Start"}
                              </Link>
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
