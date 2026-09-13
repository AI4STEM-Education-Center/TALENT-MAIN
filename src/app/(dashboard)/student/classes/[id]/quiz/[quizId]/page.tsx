"use client";
import { useParams } from "next/navigation";
import { QuizPlayer } from "@/components/quiz/QuizPlayer";

export default function QuizPage() {
  const { id: classId, quizId } = useParams<{ id: string; quizId: string }>();
  return (
    <QuizPlayer
      key={`${classId}:${quizId}`}
      mode="student"
      classId={classId}
      quizId={quizId}
      backHref={`/student/classes/${classId}`}
      backLabel="Back to class"
    />
  );
}
