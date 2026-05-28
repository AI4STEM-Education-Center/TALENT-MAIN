import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Users, BookOpen, FileQuestion, Plus, GraduationCap } from "lucide-react";

export default async function TeacherDashboard() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) redirect("/login");

  const [classCount, topicCount, questionCount] = await Promise.all([
    prisma.class.count({ where: { teacherId: teacher.id } }),
    prisma.topic.count(),
    prisma.question.count(),
  ]);

  const recentClasses = await prisma.class.findMany({
    where: { teacherId: teacher.id },
    include: { _count: { select: { enrollments: true } } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Welcome back, {session.user.firstName}!</h1>
          <p className="text-muted-foreground mt-1">Here&apos;s what&apos;s happening in your classes.</p>
        </div>
        <Button asChild>
          <Link href="/teacher/classes/new">
            <Plus className="w-4 h-4" /> New Class
          </Link>
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Classes</CardTitle>
            <Users className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{classCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Topics</CardTitle>
            <BookOpen className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{topicCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Questions</CardTitle>
            <FileQuestion className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{questionCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Classes */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Recent Classes</h2>
          <Button variant="outline" size="sm" asChild>
            <Link href="/teacher/classes">View all</Link>
          </Button>
        </div>
        {recentClasses.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <GraduationCap className="w-12 h-12 text-muted-foreground mb-4" />
              <p className="text-lg font-medium mb-2">No classes yet</p>
              <p className="text-muted-foreground text-sm mb-4">Create your first class to get started.</p>
              <Button asChild>
                <Link href="/teacher/classes/new"><Plus className="w-4 h-4" /> Create Class</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {recentClasses.map((cls) => (
              <Card key={cls.id} className="hover:shadow-md transition-shadow">
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="font-semibold">{cls.name}</p>
                    {cls.description && <p className="text-sm text-muted-foreground">{cls.description}</p>}
                    <p className="text-xs text-muted-foreground mt-1">{cls._count.enrollments} students</p>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/teacher/classes/${cls.id}`}>Manage</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
