import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/teacher/stats-ui";
import { cn } from "@/lib/utils";
import { formatDurationMs } from "@/lib/simulation-stats";
import { resourceSurfaceLabel } from "@/lib/resource-telemetry";
import {
  ENGAGEMENT_RANGES,
  getAdminResourceEngagement,
  parseEngagementRange,
} from "@/lib/resource-engagement-server";

export const dynamic = "force-dynamic";

/**
 * Admin "Learning resource engagement": how students use learning materials,
 * one row per material, split by where it was opened and by recommended vs.
 * self-directed reading. Built from LearningResourceSession (one row per open,
 * consenting students only, client-reported and clamped). The proxy already
 * keeps non-admins out of /admin/*; this gate is the second layer.
 */
export default async function AdminResourceEngagementPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  const range = parseEngagementRange((await searchParams).range);
  const data = await getAdminResourceEngagement(range);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Learning resource engagement</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How often students open learning materials, for how long, and from
          where — recommended pages on quiz results versus self-directed reading
          in the Course Materials library. Each open is one session; time counts
          only while the tab is visible. Activity is client-reported and
          recorded only for students whose research consent allows it.
        </p>
      </div>

      <nav aria-label="Report window" className="flex flex-wrap gap-2">
        {Object.entries(ENGAGEMENT_RANGES).map(([value, label]) => (
          <Link
            key={value}
            href={`/admin/resource-engagement?range=${value}`}
            aria-current={value === range ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              value === range
                ? "border-primary bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Opens" value={String(data.opens)} />
        <StatCard label="Students" value={String(data.uniqueStudents)} />
        <StatCard
          label="Recommended opens"
          value={String(data.recommendedOpens)}
          sub={
            data.opens > 0
              ? `${Math.round((data.recommendedOpens / data.opens) * 100)}% of opens`
              : undefined
          }
        />
        <StatCard
          label="Total reading time"
          value={formatDurationMs(data.totalDwellMs)}
        />
        <StatCard label="In-viewer clicks" value={String(data.totalClicks)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By surface</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {data.surfaces.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No learning-resource sessions in this window.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Opened from</th>
                  <th className="py-2 px-3 font-medium text-right">Opens</th>
                  <th className="py-2 px-3 font-medium text-right">Students</th>
                  <th className="py-2 px-3 font-medium text-right">
                    Median time
                  </th>
                  <th className="py-2 px-3 font-medium text-right">Clicks</th>
                </tr>
              </thead>
              <tbody>
                {data.surfaces.map((row) => (
                  <tr key={row.surface} className="border-b last:border-0">
                    <td className="py-2 pr-3">{row.label}</td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {row.opens}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {row.uniqueStudents}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {formatDurationMs(row.medianDwellMs)}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {row.totalClicks}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By material</CardTitle>
          {data.materialCount > data.materials.length && (
            <p className="text-xs text-muted-foreground">
              Showing the {data.materials.length} most-opened of{" "}
              {data.materialCount} materials.
            </p>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {data.materials.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No learning-resource sessions in this window.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Material</th>
                  <th className="py-2 px-3 font-medium text-right">Opens</th>
                  <th className="py-2 px-3 font-medium text-right">Students</th>
                  <th className="py-2 px-3 font-medium text-right">
                    Recommended / self-directed
                  </th>
                  <th className="py-2 px-3 font-medium text-right">
                    Total time
                  </th>
                  <th className="py-2 px-3 font-medium text-right">
                    Median time
                  </th>
                  <th className="py-2 px-3 font-medium text-right">
                    Median active
                  </th>
                  <th className="py-2 px-3 font-medium text-right">Clicks</th>
                  <th className="py-2 pl-3 font-medium">Opened from</th>
                </tr>
              </thead>
              <tbody>
                {data.materials.map((row) => (
                  <tr
                    key={row.materialId}
                    className="border-b last:border-0 align-top"
                  >
                    <td className="py-2 pr-3 font-medium">{row.title}</td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {row.opens}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {row.uniqueStudents}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {row.recommendedOpens} / {row.selfDirectedOpens}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {formatDurationMs(row.totalDwellMs)}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {formatDurationMs(row.medianDwellMs)}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {formatDurationMs(row.medianActiveMs)}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {row.totalClicks}
                    </td>
                    <td className="py-2 pl-3 text-xs text-muted-foreground">
                      {Object.entries(row.bySurface)
                        .map(
                          ([surface, count]) =>
                            `${resourceSurfaceLabel(surface)}: ${count}`,
                        )
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
