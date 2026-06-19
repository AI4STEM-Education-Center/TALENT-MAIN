import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { ScoreBanner, QuizReviewList } from "@/components/student/QuizReviewResult";
import { parseReviewSnapshot } from "@/lib/exam-results";
import { presignQuestionFigure, presignOptionImage } from "@/lib/question-figures";

const fmtDateTime = (d: Date) =>
  new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * TEACHER-ONLY full attempt detail: the complete per-question review with the
 * correct answers revealed. Students never reach this — their own results are
 * blind (score % + AI summary + holistic recommendations only). Ownership: the
 * ExamResult's class must belong to the requesting teacher and the student in
 * the URL must match the result's student.
 */
export default async function TeacherAttemptDetailPage({
  params,
}: {
  params: Promise<{ id: string; studentId: string; attemptId: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");
  const { id, studentId, attemptId } = await params;

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const cls = await prisma.class.findFirst({ where: { id, teacherId: teacher?.id ?? "" } });
  if (!cls) notFound();

  // The ExamResult is the durable snapshot (keyed by the QuizAttempt id).
  const examResult = await prisma.examResult.findUnique({ where: { quizAttemptId: attemptId } });
  if (!examResult || examResult.classId !== id || examResult.studentId !== studentId) notFound();

  const snapshot = parseReviewSnapshot(examResult.reviewSnapshot);

  // Attach transient presigned URLs (never persisted) for figures + image
  // answer-choices, mirroring how the old student results page did it.
  await Promise.all(
    snapshot.questions.map(async (q) => {
      if (q.figureStorageKey) {
        q.figureUrl = await presignQuestionFigure({ figureStorageKey: q.figureStorageKey, figureBucket: null });
      }
      await Promise.all(
        q.options.map(async (o) => {
          if (o.imageStorageKey) {
            o.imageUrl = await presignOptionImage({ imageStorageKey: o.imageStorageKey, imageBucket: null });
          }
        })
      );
    })
  );

  return (
    <div className="p-4 md:p-6 max-w-6xl space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/teacher/classes/${id}/students/${studentId}/stats`}>
          <ArrowLeft className="size-4" /> Back to student
        </Link>
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{examResult.studentName || "Attempt detail"}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {examResult.quizName} · completed {fmtDateTime(examResult.completedAt)}
        </p>
      </div>

      <Card>
        <CardContent className="py-5">
          <ScoreBanner
            score={examResult.score}
            correct={examResult.correctCount}
            total={examResult.totalCount}
          />
        </CardContent>
      </Card>

      <QuizReviewList questions={snapshot.questions} />
    </div>
  );
}
