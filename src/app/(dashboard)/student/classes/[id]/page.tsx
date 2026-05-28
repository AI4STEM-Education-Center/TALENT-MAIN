import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CheckCircle, Circle, PlayCircle, BookOpen } from "lucide-react";

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
      classTopics: {
        where: { published: true },
        include: {
          topic: {
            include: {
              subtopics: { orderBy: { order: "asc" } },
            },
          },
        },
        orderBy: { topic: { order: "asc" } },
      },
    },
  });

  if (!cls) notFound();

  // Get progress for all subtopics in this class
  const allSubtopicIds = cls.classTopics.flatMap((ct) => ct.topic.subtopics.map((s) => s.id));
  const progressRecords = await prisma.moduleProgress.findMany({
    where: { studentId: student.id, classId: id, subtopicId: { in: allSubtopicIds } },
  });
  const progressMap = new Map(progressRecords.map((p) => [p.subtopicId, p]));

  return (
    <div className="p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/student"><ArrowLeft className="w-4 h-4" /> Dashboard</Link>
      </Button>

      <div>
        <h1 className="text-3xl font-bold">{cls.name}</h1>
        <p className="text-muted-foreground text-sm mt-1">Teacher: {cls.teacher.user.firstName} {cls.teacher.user.lastName}</p>
      </div>

      {cls.classTopics.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <BookOpen className="w-12 h-12 text-muted-foreground mb-3" />
            <p className="text-lg font-medium">No content available yet</p>
            <p className="text-muted-foreground text-sm mt-1">Your teacher hasn&apos;t published any topics yet. Check back soon!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {cls.classTopics.map((ct) => {
            const subtopics = ct.topic.subtopics;
            const completed = subtopics.filter((s) => progressMap.get(s.id)?.status === "COMPLETED").length;

            return (
              <Card key={ct.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <BookOpen className="w-5 h-5 text-primary" />
                      {ct.topic.name}
                    </CardTitle>
                    <Badge variant="secondary">{completed}/{subtopics.length} completed</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {subtopics.map((subtopic, idx) => {
                      const progress = progressMap.get(subtopic.id);
                      const status = progress?.status || "NOT_STARTED";
                      const score = progress?.bestScore;

                      return (
                        <div key={subtopic.id} className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                          <div className="flex items-center gap-3">
                            {status === "COMPLETED" ? (
                              <CheckCircle className="w-5 h-5 text-green-500" />
                            ) : status === "IN_PROGRESS" ? (
                              <PlayCircle className="w-5 h-5 text-blue-500" />
                            ) : (
                              <Circle className="w-5 h-5 text-muted-foreground" />
                            )}
                            <div>
                              <p className="font-medium text-sm">{idx + 1}. {subtopic.name}</p>
                              {score !== null && score !== undefined && (
                                <p className="text-xs text-muted-foreground">Best score: {Math.round(score)}%</p>
                              )}
                            </div>
                          </div>
                          <Button size="sm" variant={status === "COMPLETED" ? "secondary" : "default"} asChild>
                            <Link href={`/student/classes/${id}/module/${subtopic.id}`}>
                              {status === "COMPLETED" ? "Retry" : status === "IN_PROGRESS" ? "Continue" : "Start"}
                            </Link>
                          </Button>
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
