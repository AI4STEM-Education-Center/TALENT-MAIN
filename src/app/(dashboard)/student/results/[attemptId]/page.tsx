import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { ExamResultsView } from "@/components/student/ExamResultsView";
import { RESULT_STATUS, type ResultStatus } from "@/lib/exam-results";
import { presignStoredRecommendations } from "@/lib/exam-results-engine";

export default async function ExamResultsPage({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");
  // params and the student lookup are independent, so race them.
  const [{ attemptId }, student] = await Promise.all([
    params,
    prisma.student.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    }),
  ]);
  if (!student) redirect("/login");

  // The ExamResult is the durable source of truth (independent of the quiz rows),
  // so this page works even if the underlying questions or attempt are gone.
  const examResult = await prisma.examResult.findUnique({ where: { quizAttemptId: attemptId } });
  if (!examResult || examResult.studentId !== student.id) notFound();

  // Blind results: the student sees only their score %, the AI summary, and the
  // holistic study recommendations — never the per-question review or the
  // correct answers. So we don't parse or presign the question snapshot here.
  const recsReady = examResult.recommendationsStatus === RESULT_STATUS.READY;
  const presigned = recsReady
    ? await presignStoredRecommendations(examResult.recommendations)
    : { items: [], truncated: false };

  return (
    <ExamResultsView
      attemptId={attemptId}
      score={examResult.score}
      initial={{
        summary: examResult.summary,
        summaryStatus: examResult.summaryStatus as ResultStatus,
        summaryMetrics: examResult.summaryAiModel
          ? {
              model: examResult.summaryAiModel,
              ttftMs: examResult.summaryTtftMs,
              generationMs: examResult.summaryGenerationMs,
              totalMs: examResult.summaryTotalMs,
              tokens: examResult.summaryTokens,
              tokensEstimated: examResult.summaryTokensEstimated === true,
            }
          : null,
        recommendations: presigned.items,
        simulations: presigned.simulations ?? [],
        recommendationsStatus: examResult.recommendationsStatus as ResultStatus,
        recommendationMetrics: examResult.recsAiModel
          ? {
              model: examResult.recsAiModel,
              ttftMs: examResult.recsTtftMs,
              generationMs: examResult.recsGenerationMs,
              totalMs: examResult.recsTotalMs,
              tokens: examResult.recsTokens,
              tokensEstimated: examResult.recsTokensEstimated === true,
            }
          : null,
        truncated: presigned.truncated,
      }}
      backHref="/student/history"
      backLabel="Exam history"
      actions={
        <Button asChild variant="outline">
          <Link href={`/student/classes/${examResult.classId}/quiz/${examResult.quizId}`}>
            <RotateCcw className="size-4" /> Retake quiz
          </Link>
        </Button>
      }
    />
  );
}
