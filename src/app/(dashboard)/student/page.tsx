import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GraduationCap, BookOpen, ChevronRight } from "lucide-react";

export default async function StudentDashboard() {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");

  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) redirect("/login");

  const [enrollments, completedCount] = await Promise.all([
    prisma.classEnrollment.findMany({
      where: { studentId: student.id },
      include: {
        class: {
          include: {
            classQuizzes: { where: { published: true } },
          },
        },
      },
      orderBy: { joinedAt: "desc" },
    }),
    // Get overall progress counts
    prisma.quizProgress.count({
      where: { studentId: student.id, status: "COMPLETED" },
    }),
  ]);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Welcome, {session.user.firstName}!</h1>
        <p className="text-muted-foreground mt-1">Continue learning from where you left off.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Enrolled Classes</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{enrollments.length}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Quizzes Completed</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{completedCount}</p></CardContent>
        </Card>
      </div>

      {/* Classes */}
      <div>
        <h2 className="text-xl font-semibold mb-4">My Classes</h2>
        {enrollments.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center py-12 text-center">
              <GraduationCap className="size-12 text-muted-foreground mb-3" />
              <p className="text-lg font-medium mb-1">No classes yet</p>
              <p className="text-muted-foreground text-sm">Ask your teacher for an invitation link to join a class.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {enrollments.map((e) => {
              const totalQuizzes = e.class.classQuizzes.length;
              return (
                <Card key={e.classId} className="hover:shadow-md transition-shadow">
                  <CardContent className="flex items-start justify-between gap-3 flex-wrap p-5">
                    <div className="space-y-1 min-w-0 flex-1">
                      <h3 className="text-lg font-semibold">{e.class.name}</h3>
                      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <BookOpen className="size-3" />
                          {totalQuizzes} quiz{totalQuizzes !== 1 ? "zes" : ""}
                        </span>
                        {totalQuizzes > 0 && (
                          <Badge variant="success">Active</Badge>
                        )}
                      </div>
                    </div>
                    <Button asChild className="shrink-0">
                      <Link href={`/student/classes/${e.classId}`}>
                        Continue <ChevronRight className="size-4" />
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
