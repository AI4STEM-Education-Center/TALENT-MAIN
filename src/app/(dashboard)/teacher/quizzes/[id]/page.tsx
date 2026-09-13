"use client";
import { useParams } from "next/navigation";
import { QuizEditor } from "@/components/quiz/QuizEditor";

export default function TeacherQuizDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <QuizEditor quizId={id} backHref="/teacher/quizzes" backLabel="Quizzes" />;
}
