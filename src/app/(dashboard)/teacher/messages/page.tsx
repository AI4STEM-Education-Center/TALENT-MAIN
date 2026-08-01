import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getTeacherEmailQuota } from "@/lib/email-limits";
import { MessageSquare, Mail, ChevronRight, Users } from "lucide-react";

export default async function TeacherMessagesPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) redirect("/login");

  const [classes, quota] = await Promise.all([
    prisma.class.findMany({
      where: { teacherId: teacher.id },
      include: { _count: { select: { enrollments: true, studentList: true } } },
      orderBy: { createdAt: "desc" },
    }),
    getTeacherEmailQuota(teacher.userId, {
      emailDailyLimit: teacher.emailDailyLimit,
      emailMonthlyLimit: teacher.emailMonthlyLimit,
    }),
  ]);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MessageSquare className="size-6" /> Messages
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Pick a class to message. Students get an in-app notification, plus an automated email if they have an
          address on file.
        </p>
      </div>

      <div className="text-sm rounded-md border bg-muted/30 p-3 flex items-start gap-2">
        <Mail className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
        <span>
          <strong>Email budget:</strong> {quota.dailyRemaining} left today (of {quota.dailyLimit}) ·{" "}
          {quota.monthlyRemaining} left this month (of {quota.monthlyLimit}). In-app notifications are unlimited, and
          a class over budget is still notified in-app.
        </span>
      </div>

      {classes.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            You don&apos;t have any classes yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {classes.map((c) => (
            <Card key={c.id} className="hover:shadow-md transition-shadow">
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-semibold">{c.name}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                    <Users className="size-3" /> {c._count.enrollments} enrolled · {c._count.studentList} in roster
                  </p>
                </div>
                <Button size="sm" asChild className="shrink-0">
                  <Link href={`/teacher/classes/${c.id}/messages`}>
                    Compose <ChevronRight className="size-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
