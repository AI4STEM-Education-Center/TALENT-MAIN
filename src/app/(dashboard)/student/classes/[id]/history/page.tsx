import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { ExamHistoryList, type ExamHistoryItem } from "@/components/student/ExamHistoryList";

export default async function ClassExamHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");
  const { id } = await params;

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!student) redirect("/login");

  // Confirm enrollment before showing class-scoped history.
  const enrollment = await prisma.classEnrollment.findUnique({
    where: { classId_studentId: { classId: id, studentId: student.id } },
  });
  if (!enrollment) notFound();

  const cls = await prisma.class.findUnique({ where: { id }, select: { name: true } });
  if (!cls) notFound();

  const results = await prisma.examResult.findMany({
    where: { studentId: student.id, classId: id },
    orderBy: { completedAt: "desc" },
    select: {
      quizAttemptId: true,
      className: true,
      topicName: true,
      quizName: true,
      score: true,
      completedAt: true,
    },
  });

  const items: ExamHistoryItem[] = results.map((r) => ({
    attemptId: r.quizAttemptId,
    className: r.className,
    topicName: r.topicName,
    quizName: r.quizName,
    score: r.score,
    completedAt: r.completedAt.toISOString(),
  }));

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/student/classes/${id}`}>
          <ArrowLeft className="size-4" /> Back to class
        </Link>
      </Button>
      <div>
        <h1 className="text-3xl font-bold">Exam History</h1>
        <p className="text-muted-foreground text-sm mt-1">{cls.name}</p>
      </div>
      <ExamHistoryList items={items} showClass={false} />
    </div>
  );
}
