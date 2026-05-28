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

  const enrollments = await prisma.classEnrollment.findMany({
    where: { studentId: student.id },
    include: {
      class: {
        include: {
          classTopics: {
            where: { published: true },
            include: { topic: { include: { subtopics: true } } },
          },
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });

  // Get overall progress counts
  const completedCount = await prisma.moduleProgress.count({
    where: { studentId: student.id, status: "COMPLETED" },
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Welcome, {session.user.firstName}!</h1>
        <p className="text-muted-foreground mt-1">Continue learning from where you left off.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Enrolled Classes</CardTitle>
          </CardHeader>
          <CardContent><p className="text-3xl font-bold">{enrollments.length}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Modules Completed</CardTitle>
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
              <GraduationCap className="w-12 h-12 text-muted-foreground mb-3" />
              <p className="text-lg font-medium mb-1">No classes yet</p>
              <p className="text-muted-foreground text-sm">Ask your teacher for an invitation link to join a class.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {enrollments.map((e) => {
              const totalModules = e.class.classTopics.reduce((sum, ct) => sum + ct.topic.subtopics.length, 0);
              return (
                <Card key={e.classId} className="hover:shadow-md transition-shadow">
                  <CardContent className="flex items-center justify-between p-5">
                    <div className="space-y-1">
                      <h3 className="text-lg font-semibold">{e.class.name}</h3>
                      <div className="flex gap-3 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <BookOpen className="w-3 h-3" />
                          {e.class.classTopics.length} topic{e.class.classTopics.length !== 1 ? "s" : ""}
                        </span>
                        <span>{totalModules} module{totalModules !== 1 ? "s" : ""}</span>
                        {e.class.classTopics.length > 0 && (
                          <Badge variant="success">Active</Badge>
                        )}
                      </div>
                    </div>
                    <Button asChild>
                      <Link href={`/student/classes/${e.classId}`}>
                        Continue <ChevronRight className="w-4 h-4" />
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
