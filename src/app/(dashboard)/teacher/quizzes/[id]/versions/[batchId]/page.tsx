import { QuizVariantBatchReview } from "@/components/quiz/QuizVariantBatchReview";

// Direct review link for one generation round (from the email/notification).
export default async function TeacherQuizVersionBatchPage({
  params,
}: {
  params: Promise<{ id: string; batchId: string }>;
}) {
  const { id, batchId } = await params;
  return (
    <QuizVariantBatchReview
      quizId={id}
      batchId={batchId}
      quizHrefBase="/teacher/quizzes"
    />
  );
}
