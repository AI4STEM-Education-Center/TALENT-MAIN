import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { ExamHistoryList, type ExamHistoryItem } from "@/components/student/ExamHistoryList";

export default async function StudentHistoryPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!student) redirect("/login");

  const results = await prisma.examResult.findMany({
    where: { studentId: student.id },
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
      <div>
        <h1 className="text-3xl font-bold">Exam History</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Review your past quizzes, summaries, and study recommendations.
        </p>
      </div>
      <ExamHistoryList items={items} showClass />
    </div>
  );
}
