import { prisma } from "@/lib/prisma";
import { requireStatsUser } from "@/lib/stats-access";
import { formatDurationMs } from "@/lib/simulation-stats";

export const USAGE_KINDS = {
  results: "Completed quizzes",
  attempts: "In-progress quizzes",
  practice: "Practice attempts",
  simulations: "Simulation sessions",
} as const;
export type UsageKind = keyof typeof USAGE_KINDS;
export type AdminSearchParams = Record<string, string | string[] | undefined>;
export const PAGE_SIZE = 50;
export const searchValue = (value: string | string[] | undefined) =>
  typeof value === "string" ? value.trim() : "";
export function pageNumber(value: string | string[] | undefined) {
  const page = Number(searchValue(value));
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000_000) : 1;
}

type UsageRecord = {
  id: string;
  studentId: string;
  classId: string | null;
  quizId: string | null;
  title: string;
  startedAt: Date;
  completedAt: Date | null;
  detail: string;
  studentName?: string | null;
  className?: string;
  href?: string;
};

/** Admin-only, paginated reads of the recorded activity, including durable archives. */
export async function getAdminUsage(params: AdminSearchParams) {
  await requireStatsUser("admin");
  const requestedKind = searchValue(params.kind);
  const kind: UsageKind = Object.hasOwn(USAGE_KINDS, requestedKind)
    ? (requestedKind as UsageKind)
    : "results";
  const page = pageNumber(params.page);
  const studentId = searchValue(params.studentId);
  const classId = searchValue(params.classId);
  const q = searchValue(params.q);
  const matchingStudents = q
    ? await prisma.student.findMany({
        where: {
          user: {
            OR: [
              { firstName: { contains: q } },
              { lastName: { contains: q } },
              { email: { contains: q } },
              { username: { contains: q } },
            ],
          },
        },
        select: { id: true },
      })
    : [];
  const scope = {
    ...(studentId && { studentId }),
    ...(classId && { classId }),
  };
  const matches = {
    studentId: { in: matchingStudents.map((student) => student.id) },
  };
  const where = { ...scope, ...(q && { AND: [matches] }) };
  const resultsWhere = {
    ...scope,
    ...(q && { OR: [matches, { studentName: { contains: q } }] }),
  };
  const pagination = { skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE };
  let records: UsageRecord[];
  let total: number;

  if (kind === "results") {
    const [rows, count] = await Promise.all([
      prisma.examResult.findMany({
        where: resultsWhere,
        ...pagination,
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          quizAttemptId: true,
          studentId: true,
          classId: true,
          quizId: true,
          studentName: true,
          className: true,
          quizName: true,
          completedAt: true,
          score: true,
        },
      }),
      prisma.examResult.count({ where: resultsWhere }),
    ]);
    total = count;
    records = rows.map((row) => ({
      ...row,
      title: row.quizName,
      startedAt: row.completedAt,
      detail: `${Math.round(row.score * 100) / 100}%`,
      href: `/admin/classes/${row.classId}/students/${row.studentId}/attempts/${row.quizAttemptId}`,
    }));
  } else if (kind === "attempts") {
    const filter = { ...where, completedAt: null };
    const [rows, count] = await Promise.all([
      prisma.quizAttempt.findMany({
        where: filter,
        ...pagination,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          studentId: true,
          classId: true,
          quizId: true,
          startedAt: true,
          completedAt: true,
        },
      }),
      prisma.quizAttempt.count({ where: filter }),
    ]);
    total = count;
    records = rows.map((row) => ({
      ...row,
      title: "Quiz",
      detail: "In progress",
    }));
  } else if (kind === "practice") {
    const [rows, count] = await Promise.all([
      prisma.quizPracticeAttempt.findMany({
        where,
        ...pagination,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          studentId: true,
          classId: true,
          quizId: true,
          versionName: true,
          score: true,
          startedAt: true,
          completedAt: true,
        },
      }),
      prisma.quizPracticeAttempt.count({ where }),
    ]);
    total = count;
    records = rows.map((row) => ({
      ...row,
      title: row.versionName,
      detail: row.completedAt
        ? `Completed · ${row.score === null ? "—" : `${Math.round(row.score * 100) / 100}%`}`
        : "In progress",
    }));
  } else {
    const [rows, count] = await Promise.all([
      prisma.simulationSession.findMany({
        where,
        ...pagination,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          studentId: true,
          classId: true,
          quizId: true,
          simulationId: true,
          startedAt: true,
          endedAt: true,
          activeMs: true,
          dwellMs: true,
          interactionCount: true,
          paramChanges: true,
          surface: true,
        },
      }),
      prisma.simulationSession.count({ where }),
    ]);
    const simulations = await prisma.questionSimulation.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.simulationId))] } },
      select: { id: true, title: true },
    });
    const titles = new Map(simulations.map((sim) => [sim.id, sim.title]));
    total = count;
    records = rows.map((row) => ({
      ...row,
      title: titles.get(row.simulationId) || "Removed simulation",
      completedAt: row.endedAt,
      detail: `${formatDurationMs(row.activeMs)} active / ${formatDurationMs(row.dwellMs)} open · ${row.interactionCount} interactions · ${row.paramChanges} control changes · ${row.surface}`,
    }));
  }

  // Resolve only this page's identities. Relation-free records survive deleted accounts/classes.
  const [students, classes, quizzes] = await Promise.all([
    prisma.student.findMany({
      where: { id: { in: [...new Set(records.map((row) => row.studentId))] } },
      select: {
        id: true,
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    }),
    prisma.class.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              records.flatMap((row) => (row.classId ? [row.classId] : [])),
            ),
          ],
        },
      },
      select: { id: true, name: true },
    }),
    prisma.quiz.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              records.flatMap((row) => (row.quizId ? [row.quizId] : [])),
            ),
          ],
        },
      },
      select: { id: true, name: true },
    }),
  ]);
  const studentNames = new Map(
    students.map((student) => [student.id, student.user]),
  );
  const classNames = new Map(classes.map((cls) => [cls.id, cls.name]));
  const quizNames = new Map(quizzes.map((quiz) => [quiz.id, quiz.name]));
  return {
    kind,
    q,
    page,
    total,
    studentId,
    classId,
    records: records.map((row) => {
      const student = studentNames.get(row.studentId);
      return {
        ...row,
        studentName: student
          ? `${student.firstName} ${student.lastName}`
          : row.studentName || "Deleted student",
        studentEmail: student?.email ?? row.studentId,
        className:
          row.className ||
          (row.classId
            ? classNames.get(row.classId) || "Deleted class"
            : "Outside a class"),
        classHref:
          row.classId && classNames.has(row.classId)
            ? `/admin/classes/${row.classId}/stats`
            : null,
        quizName: row.quizId
          ? (quizNames.get(row.quizId) ?? "Deleted quiz")
          : "—",
      };
    }),
  };
}
