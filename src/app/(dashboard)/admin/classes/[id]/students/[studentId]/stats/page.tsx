import { StudentStatsView } from "@/components/stats/student-stats-view";

export default function Page({
  params,
}: {
  params: Promise<{ id: string; studentId: string }>;
}) {
  return <StudentStatsView params={params} audience="admin" />;
}
