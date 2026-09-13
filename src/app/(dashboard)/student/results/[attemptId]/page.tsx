import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { ExamResultsView } from "@/components/student/ExamResultsView";
import {
  RESULT_STATUS,
  parseReviewSnapshot,
  snapshotToStudentMistakes,
  type PresignedRecommendations,
  type ResultStatus,
} from "@/lib/exam-results";
import {
  presignStoredRecommendations,
  presignStudentMistakes,
} from "@/lib/exam-results-engine";

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

  // Build the student-safe review before crossing the server/client boundary.
  // The transform keeps missed prompts and submitted responses only; correct
  // answers, unselected choices, grading flags, and raw storage keys stay out.
  const mistakesSource = snapshotToStudentMistakes(
    parseReviewSnapshot(examResult.reviewSnapshot)
  );
  const recsReady = examResult.recommendationsStatus === RESULT_STATUS.READY;
  const [presigned, mistakes] = await Promise.all([
    recsReady
      ? presignStoredRecommendations(examResult.recommendations)
      : Promise.resolve<PresignedRecommendations>({
          items: [],
          truncated: false,
        }),
    presignStudentMistakes(mistakesSource),
  ]);

  return (
    <ExamResultsView
      attemptId={attemptId}
      score={examResult.score}
      mistakes={mistakes}
      initial={{
        summary: examResult.summary,
        summaryStatus: examResult.summaryStatus as ResultStatus,
        summaryMetrics: examResult.summaryAiModel
          ? {
              model: examResult.summaryAiModel,
              provider: examResult.summaryAiProvider,
              serviceTier: examResult.summaryServiceTier,
              thinkingLevel: examResult.summaryThinkingLevel,
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
              provider: examResult.recsAiProvider,
              serviceTier: examResult.recsServiceTier,
              thinkingLevel: examResult.recsThinkingLevel,
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
