import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  getAdminUsage,
  PAGE_SIZE,
  USAGE_KINDS,
  type AdminSearchParams,
} from "@/lib/admin-usage";

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<AdminSearchParams>;
}) {
  const usage = await getAdminUsage(await searchParams);
  const href = (page: number, studentId = usage.studentId) =>
    `/admin/usage?${new URLSearchParams({
      kind: usage.kind,
      q: usage.q,
      classId: usage.classId,
      studentId,
      page: String(page),
    })}`;
  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Student usage records</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quiz results, unfinished quizzes, practice attempts, and recorded
          simulation sessions across all classes. Simulation activity is
          client-reported and is recorded only when research consent allows it.
        </p>
        <Link
          href="/admin/assistant-chats"
          className="text-sm text-primary hover:underline"
        >
          View assistant chat transcripts
        </Link>
      </div>
      <form className="flex flex-wrap items-end gap-3" action="/admin/usage">
        <label className="grid gap-1 text-sm">
          Activity
          <select
            name="kind"
            defaultValue={usage.kind}
            className="h-9 rounded-md border bg-background px-3"
          >
            {Object.entries(USAGE_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Student name or email
          <Input
            name="q"
            defaultValue={usage.q}
            placeholder="Search students…"
          />
        </label>
        <input type="hidden" name="classId" value={usage.classId} />
        <input type="hidden" name="studentId" value={usage.studentId} />
        <Button type="submit">Apply filters</Button>
        <Button variant="ghost" asChild>
          <Link href="/admin/usage">Clear</Link>
        </Button>
      </form>
      {(usage.classId || usage.studentId) && (
        <p className="text-sm text-muted-foreground">
          Showing{" "}
          {usage.studentId
            ? usage.records[0]?.studentName || "selected student"
            : "all students"}
          {usage.classId
            ? ` in ${usage.records[0]?.className || "selected class"}`
            : " across all classes"}
          .
        </p>
      )}
      <Link
        href="/admin/classes"
        className="text-sm text-primary hover:underline"
      >
        Browse usage by class
      </Link>
      <p className="text-sm text-muted-foreground">
        {usage.total} records · page {usage.page} of{" "}
        {Math.max(1, Math.ceil(usage.total / PAGE_SIZE))}
      </p>
      <Card>
        <CardContent className="p-4 overflow-x-auto">
          {usage.records.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              No usage records match these filters.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">Student</th>
                  <th className="p-2">Class</th>
                  <th className="p-2">Activity</th>
                  <th className="p-2">
                    {usage.kind === "results" ? "Completed" : "Started"}
                  </th>
                  <th className="p-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {usage.records.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 align-top">
                    <td className="p-2">
                      <Link
                        href={href(1, row.studentId)}
                        className="font-medium text-primary hover:underline"
                      >
                        {row.studentName}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {row.studentEmail}
                      </p>
                    </td>
                    <td className="p-2">
                      {row.classHref ? (
                        <Link
                          href={row.classHref}
                          className="text-primary hover:underline"
                        >
                          {row.className}
                        </Link>
                      ) : (
                        row.className
                      )}
                    </td>
                    <td className="p-2">
                      {row.href ? (
                        <Link
                          href={row.href}
                          className="text-primary hover:underline"
                        >
                          {row.title}
                        </Link>
                      ) : (
                        row.title
                      )}
                      {usage.kind !== "results" && (
                        <p className="text-xs text-muted-foreground">
                          {row.quizName}
                        </p>
                      )}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {row.startedAt.toLocaleString()}
                      {usage.kind !== "results" && row.completedAt && (
                        <p className="text-xs text-muted-foreground">
                          Ended {row.completedAt.toLocaleString()}
                        </p>
                      )}
                    </td>
                    <td className="p-2">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <nav aria-label="Usage pagination" className="flex gap-2">
        {usage.page > 1 && (
          <Button variant="outline" asChild>
            <Link href={href(usage.page - 1)}>Previous</Link>
          </Button>
        )}
        {usage.page * PAGE_SIZE < usage.total && (
          <Button variant="outline" asChild>
            <Link href={href(usage.page + 1)}>Next</Link>
          </Button>
        )}
      </nav>
    </div>
  );
}
