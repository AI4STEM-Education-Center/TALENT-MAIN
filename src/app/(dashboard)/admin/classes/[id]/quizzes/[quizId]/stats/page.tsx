import { QuizStatsView } from "@/components/stats/quiz-stats-view";

export default function Page({
  params,
}: {
  params: Promise<{ id: string; quizId: string }>;
}) {
  return <QuizStatsView params={params} audience="admin" />;
}
