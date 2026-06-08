import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { ExamResultsView } from "@/components/student/ExamResultsView";
import { parseReviewSnapshot, RESULT_STATUS, type ResultStatus } from "@/lib/exam-results";
import { presignStoredRecommendations } from "@/lib/exam-results-engine";

export default async function ExamResultsPage({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");
  const { attemptId } = await params;

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!student) redirect("/login");

  // The ExamResult is the durable source of truth (independent of the quiz rows),
  // so this page works even if the underlying questions or attempt are gone.
  const examResult = await prisma.examResult.findUnique({ where: { quizAttemptId: attemptId } });
  if (!examResult || examResult.studentId !== student.id) notFound();

  const snapshot = parseReviewSnapshot(examResult.reviewSnapshot);
  const recsReady = examResult.recommendationsStatus === RESULT_STATUS.READY;
  const presigned = recsReady
    ? await presignStoredRecommendations(examResult.recommendations)
    : { items: [], truncated: false };

  return (
    <ExamResultsView
      attemptId={attemptId}
      score={examResult.score}
      correct={examResult.correctCount}
      total={examResult.totalCount}
      questions={snapshot.questions}
      initial={{
        summary: examResult.summary,
        summaryStatus: examResult.summaryStatus as ResultStatus,
        recommendations: presigned.items,
        recommendationsStatus: examResult.recommendationsStatus as ResultStatus,
        truncated: presigned.truncated,
      }}
      backHref="/student/history"
      backLabel="Exam history"
      actions={
        <Button asChild variant="outline">
          <Link href={`/student/classes/${examResult.classId}/module/${examResult.subtopicId}`}>
            <RotateCcw className="size-4" /> Retake quiz
          </Link>
        </Button>
      }
    />
  );
}
