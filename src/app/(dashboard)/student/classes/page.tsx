import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  GraduationCap,
  BookOpen,
  CheckCircle,
  User,
  History,
  ChevronRight,
} from "lucide-react";

export default async function StudentClassesPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
  });
  if (!student) redirect("/login");

  const [enrollments, completedGroups] = await Promise.all([
    prisma.classEnrollment.findMany({
      where: { studentId: student.id },
      include: {
        class: {
          include: {
            teacher: {
              include: {
                user: { select: { firstName: true, lastName: true } },
              },
            },
            classQuizzes: {
              where: { published: true },
              select: { quizId: true },
            },
          },
        },
      },
      orderBy: { joinedAt: "desc" },
    }),
    // Completed-quiz counts per class, so each card can show how far along the
    // student is without a query per class.
    prisma.quizProgress.groupBy({
      by: ["classId"],
      where: { studentId: student.id, status: "COMPLETED" },
      _count: { _all: true },
    }),
  ]);

  const completedByClass = new Map(
    completedGroups.map((g) => [g.classId, g._count._all]),
  );

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">My Classes</h1>
        <p className="text-muted-foreground mt-1">
          {enrollments.length} class{enrollments.length !== 1 ? "es" : ""}{" "}
          enrolled
        </p>
      </div>

      {enrollments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <GraduationCap className="size-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">No classes yet</p>
            <p className="text-muted-foreground text-sm">
              Ask your teacher for an invitation link to join a class.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {enrollments.map((e) => {
            const totalQuizzes = e.class.classQuizzes.length;
            const completed = Math.min(
              completedByClass.get(e.classId) ?? 0,
              totalQuizzes,
            );
            const allDone = totalQuizzes > 0 && completed === totalQuizzes;
            const teacher = e.class.teacher.user;
            return (
              <Card
                key={e.classId}
                className="hover:shadow-md transition-shadow"
              >
                <CardContent className="flex items-start justify-between gap-3 flex-wrap p-5">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-semibold">{e.class.name}</h2>
                      {allDone && (
                        <Badge variant="success" className="gap-1">
                          <CheckCircle className="size-3" /> Complete
                        </Badge>
                      )}
                    </div>
                    {e.class.description && (
                      <p className="text-sm text-muted-foreground">
                        {e.class.description}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pt-1">
                      <span className="flex items-center gap-1">
                        <User className="size-3" />
                        {teacher.firstName} {teacher.lastName}
                      </span>
                      <span className="flex items-center gap-1">
                        <BookOpen className="size-3" />
                        {totalQuizzes} quiz{totalQuizzes !== 1 ? "zes" : ""}
                      </span>
                      {totalQuizzes > 0 && (
                        <span>
                          {completed} of {totalQuizzes} completed
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/student/classes/${e.classId}/history`}>
                        <History className="size-4" /> History
                      </Link>
                    </Button>
                    <Button size="sm" asChild>
                      <Link href={`/student/classes/${e.classId}`}>
                        Continue <ChevronRight className="size-4" />
                      </Link>
                    </Button>
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
