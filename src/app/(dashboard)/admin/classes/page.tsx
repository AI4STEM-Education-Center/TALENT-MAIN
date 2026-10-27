import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireStatsUser } from "@/lib/stats-access";
import {
  pageNumber,
  searchValue,
  PAGE_SIZE,
  type AdminSearchParams,
} from "@/lib/admin-usage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ClassResearchToggle } from "./class-research-toggle";

const RESEARCH_FILTERS = {
  all: "All classes",
  included: "Prompted for research",
  excluded: "Excluded from research",
} as const;
type ResearchFilter = keyof typeof RESEARCH_FILTERS;

function researchFilter(value: string | string[] | undefined): ResearchFilter {
  const v = searchValue(value);
  return v === "included" || v === "excluded" ? v : "all";
}

export default async function AdminClassesPage({
  searchParams,
}: {
  searchParams: Promise<AdminSearchParams>;
}) {
  await requireStatsUser("admin");
  const params = await searchParams;
  const q = searchValue(params.q);
  const page = pageNumber(params.page);
  const research = researchFilter(params.research);
  const search = q
    ? {
        OR: [
          { name: { contains: q } },
          {
            teacher: {
              user: {
                OR: [
                  { firstName: { contains: q } },
                  { lastName: { contains: q } },
                  { email: { contains: q } },
                ],
              },
            },
          },
        ],
      }
    : {};
  const where =
    research === "all"
      ? search
      : { ...search, researchExcluded: research === "excluded" };
  const [classes, total, excludedTotal] = await Promise.all([
    prisma.class.findMany({
      where,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        name: true,
        researchExcluded: true,
        teacher: {
          select: {
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
        _count: {
          select: { enrollments: true, classQuizzes: true, quizAttempts: true },
        },
      },
    }),
    prisma.class.count({ where }),
    prisma.class.count({ where: { researchExcluded: true } }),
  ]);
  const sessions = await prisma.simulationSession.groupBy({
    by: ["classId"],
    where: { classId: { in: classes.map((cls) => cls.id) } },
    _count: { _all: true },
  });
  const sessionCounts = new Map(
    sessions.map((row) => [row.classId, row._count._all]),
  );
  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Class statistics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          All teachers’ classes, quiz performance, student results, and
          simulation engagement.
        </p>
      </div>
      <form action="/admin/classes" className="flex flex-wrap gap-2">
        <Input
          name="q"
          defaultValue={q}
          placeholder="Search classes or teachers…"
          aria-label="Search classes or teachers"
          className="max-w-md"
        />
        <select
          name="research"
          defaultValue={research}
          aria-label="Filter by research prompts"
          className="h-10 rounded-[var(--radius)] border-[length:var(--border-width)] border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {Object.entries(RESEARCH_FILTERS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button type="submit">Search</Button>
      </form>
      <p className="text-sm text-muted-foreground">
        {total} classes · page {page} of{" "}
        {Math.max(1, Math.ceil(total / PAGE_SIZE))}
        {excludedTotal > 0 &&
          ` · ${excludedTotal} excluded from research prompts`}
      </p>
      <p className="text-xs text-muted-foreground">
        Research prompts are the IRB consent form and the pre/post surveys.
        Students and teachers are skipped only when every class they belong to
        is excluded.
      </p>
      <Card>
        <CardContent className="p-4 overflow-x-auto">
          {classes.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              No classes match this search.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">Class</th>
                  <th className="p-2">Teacher</th>
                  <th className="p-2">Students</th>
                  <th className="p-2">Quizzes</th>
                  <th className="p-2">Attempts</th>
                  <th className="p-2">Simulation sessions</th>
                  <th className="p-2">Usage</th>
                  <th className="p-2">Research prompts</th>
                </tr>
              </thead>
              <tbody>
                {classes.map((cls) => (
                  <tr key={cls.id} className="border-b last:border-0">
                    <td className="p-2">
                      <Link
                        href={`/admin/classes/${cls.id}/stats`}
                        className="font-medium text-primary hover:underline"
                      >
                        {cls.name}
                      </Link>
                    </td>
                    <td className="p-2">
                      {cls.teacher.user.firstName} {cls.teacher.user.lastName}
                      <p className="text-xs text-muted-foreground">
                        {cls.teacher.user.email}
                      </p>
                    </td>
                    <td className="p-2">{cls._count.enrollments}</td>
                    <td className="p-2">{cls._count.classQuizzes}</td>
                    <td className="p-2">{cls._count.quizAttempts}</td>
                    <td className="p-2">{sessionCounts.get(cls.id) ?? 0}</td>
                    <td className="p-2">
                      <Link
                        href={`/admin/usage?classId=${cls.id}`}
                        className="text-primary hover:underline"
                      >
                        View records
                      </Link>
                    </td>
                    <td className="p-2">
                      <ClassResearchToggle
                        classId={cls.id}
                        className={cls.name}
                        excluded={cls.researchExcluded}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <nav aria-label="Class pagination" className="flex gap-2">
        {page > 1 && (
          <Button variant="outline" asChild>
            <Link
              href={`/admin/classes?${new URLSearchParams({ q, research, page: String(page - 1) })}`}
            >
              Previous
            </Link>
          </Button>
        )}
        {page * PAGE_SIZE < total && (
          <Button variant="outline" asChild>
            <Link
              href={`/admin/classes?${new URLSearchParams({ q, research, page: String(page + 1) })}`}
            >
              Next
            </Link>
          </Button>
        )}
      </nav>
    </div>
  );
}
