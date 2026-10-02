import { AttemptDetailView } from "@/components/stats/attempt-detail-view";

export default function Page({
  params,
}: {
  params: Promise<{ id: string; studentId: string; attemptId: string }>;
}) {
  return <AttemptDetailView params={params} audience="admin" />;
}
