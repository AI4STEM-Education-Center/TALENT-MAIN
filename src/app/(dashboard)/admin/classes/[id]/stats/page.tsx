import { ClassStatsView } from "@/components/stats/class-stats-view";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <ClassStatsView params={params} audience="admin" />;
}
