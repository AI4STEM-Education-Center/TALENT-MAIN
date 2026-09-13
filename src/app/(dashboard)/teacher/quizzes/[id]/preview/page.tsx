import { QuizPlayer } from "@/components/quiz/QuizPlayer";

export default async function TeacherQuizPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ classId?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const classId = typeof query.classId === "string" ? query.classId : undefined;
  const backHref = classId
    ? `/teacher/classes/${encodeURIComponent(classId)}/quizzes`
    : `/teacher/quizzes/${encodeURIComponent(id)}`;

  return (
    <>
      <div
        className="mx-4 mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4 md:mx-6 md:mt-6"
        role="note"
      >
        <h1 className="text-lg font-semibold">Student preview</h1>
        <p className="text-sm text-muted-foreground">
          Take the quiz as a student. Your answers and score are not saved. AI
          reports and recommendations are not generated in preview.
        </p>
      </div>
      <QuizPlayer
        key={id}
        mode="preview"
        quizId={id}
        backHref={backHref}
        backLabel={classId ? "Back to class quizzes" : "Back to quiz"}
      />
    </>
  );
}
