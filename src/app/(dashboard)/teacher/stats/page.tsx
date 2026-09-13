import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { BarChart3, BookOpen, Users, ChevronRight } from "lucide-react";

const fmtDate = (d: Date) =>
  new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

export default async function TeacherStatsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });

  const classes = teacher
    ? await prisma.class.findMany({
        where: { teacherId: teacher.id },
        include: { _count: { select: { enrollments: true, classQuizzes: true } } },
        orderBy: { createdAt: "desc" },
      })
    : [];

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="size-6" /> Statistics
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Select a class to view its per-quiz and per-student performance.
        </p>
      </div>

      {classes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <BarChart3 className="size-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">No classes yet</p>
            <p className="text-muted-foreground text-sm">
              Create a class and assign quizzes to start seeing statistics.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {classes.map((cls) => (
            <Link key={cls.id} href={`/teacher/classes/${cls.id}/stats`} className="block">
              <Card className="hover:shadow-md transition-shadow">
                <CardContent className="flex items-center justify-between gap-3 flex-wrap p-5">
                  <div className="space-y-1 min-w-0 flex-1">
                    <h2 className="text-lg font-semibold">{cls.name}</h2>
                    {cls.description && (
                      <p className="text-sm text-muted-foreground">{cls.description}</p>
                    )}
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pt-1">
                      <span className="flex items-center gap-1">
                        <Users className="size-3" />
                        {cls._count.enrollments} students
                      </span>
                      <span className="flex items-center gap-1">
                        <BookOpen className="size-3" />
                        {cls._count.classQuizzes} quizzes
                      </span>
                      <span>Created {fmtDate(cls.createdAt)}</span>
                    </div>
                  </div>
                  <ChevronRight className="size-5 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
