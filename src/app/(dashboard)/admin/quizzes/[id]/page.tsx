"use client";
import { useParams } from "next/navigation";
import { QuizEditor } from "@/components/quiz/QuizEditor";

export default function AdminQuizDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <QuizEditor quizId={id} backHref="/admin/quizzes" backLabel="Quiz Pool" />
  );
}
