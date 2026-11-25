"use client";
import { useParams } from "next/navigation";
import { UnifiedQuizLauncher } from "@/components/quiz/UnifiedQuizLauncher";

export default function PracticePage() {
  const { id: classId, quizId } = useParams<{ id: string; quizId: string }>();
  return (
    <UnifiedQuizLauncher
      key={`${classId}:${quizId}`}
      initialMode="practice"
      classId={classId}
      quizId={quizId}
      backHref={`/student/classes/${classId}`}
      backLabel="Back to class"
    />
  );
}
