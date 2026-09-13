import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GraduationCap, BookOpen, ChevronRight, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

/** Classes shown on the dashboard before deferring to the full /student/classes list. */
const DASHBOARD_CLASS_PREVIEW = 3;

export default async function StudentDashboard() {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");

  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) redirect("/login");

  const [enrollments, completedCount, notifications] = await Promise.all([
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
    // Most recent notifications for the dashboard mailbox preview
    prisma.notification.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      take: 4,
      include: {
        message: {
          select: {
            subject: true,
            sender: { select: { firstName: true, lastName: true } },
            class: { select: { name: true } },
          },
        },
      },
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

      {/* Notifications */}
      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Inbox className="size-5" /> Notifications
          </h2>
          <Button variant="outline" size="sm" asChild className="shrink-0">
            <Link href="/student/notifications">View all</Link>
          </Button>
        </div>
        <Card>
          <CardContent className="p-0 divide-y">
            {notifications.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No notifications yet.</p>
            ) : (
              notifications.map((n) => (
                <Link
                  key={n.id}
                  href="/student/notifications"
                  className={cn(
                    "block px-4 py-3 hover:bg-muted/40 transition-colors",
                    !n.readAt && "bg-primary/5"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn("text-sm", !n.readAt ? "font-semibold" : "font-medium")}>
                      {n.message.subject}
                    </span>
                    {!n.readAt && <span className="size-2 rounded-full bg-primary shrink-0" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {n.message.sender.firstName} {n.message.sender.lastName}
                    {n.message.class ? ` · ${n.message.class.name}` : ""} ·{" "}
                    {new Date(n.createdAt).toLocaleDateString()}
                  </p>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Classes — a preview; the full list lives at /student/classes */}
      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <GraduationCap className="size-5" /> My Classes
          </h2>
          {enrollments.length > 0 && (
            <Button variant="outline" size="sm" asChild className="shrink-0">
              <Link href="/student/classes">View all</Link>
            </Button>
          )}
        </div>
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
            {enrollments.slice(0, DASHBOARD_CLASS_PREVIEW).map((e) => {
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
            {enrollments.length > DASHBOARD_CLASS_PREVIEW && (
              <Link
                href="/student/classes"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors text-center"
              >
                + {enrollments.length - DASHBOARD_CLASS_PREVIEW} more class
                {enrollments.length - DASHBOARD_CLASS_PREVIEW !== 1 ? "es" : ""}
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
