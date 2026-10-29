import { prisma } from "@/lib/prisma";
import { requireStatsUser } from "@/lib/stats-access";
import { formatDurationMs } from "@/lib/simulation-stats";
import {
  simulationSurfaceLabel,
  simulationViewportLabel,
} from "@/lib/simulation-telemetry";
import { resourceSurfaceLabel } from "@/lib/resource-telemetry";

export const USAGE_KINDS = {
  results: "Completed quizzes",
  attempts: "In-progress quizzes",
  practice: "Practice attempts",
  simulations: "Simulation sessions",
  materials: "Learning material views",
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
  /** Launch surface, for explaining why a session has no class. */
  surface?: string;
  attemptId?: string | null;
  /** Replaces the quiz line under the activity title. */
  subtitle?: string;
};

/**
 * Class cell for a record stored without a class. Computed at read time from
 * the stored surface, so every existing row gets the current wording. The
 * session routes leave classId null on purpose for self-directed library
 * opens (simulations always; materials when shared with several of the
 * student's classes), and when a results-page open couldn't be tied to a
 * verified attempt in a class that assigns the quiz.
 */
export function unassignedClassLabel(row: {
  surface?: string;
  attemptId?: string | null;
}): { label: string; note: string } {
  switch (row.surface) {
    case "library":
      return {
        label: "Simulations library",
        note: "Self-directed open, not tied to a class",
      };
    case "materials_library":
      return {
        label: "Course materials library",
        note: "Self-directed open of a material shared with more than one of the student's classes",
      };
    case undefined:
      return { label: "No class recorded", note: "" };
    default:
      return {
        label: "No class recorded",
        note: row.attemptId
          ? "Opened from quiz results whose class no longer assigns this quiz"
          : "Opened from quiz results without a verified attempt",
      };
  }
}

/** Admin-data (admin + research scientist), paginated reads of the recorded activity, including durable archives. */
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
  } else if (kind === "materials") {
    const [rows, count] = await Promise.all([
      prisma.learningResourceSession.findMany({
        where,
        ...pagination,
        orderBy: [{ openedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          studentId: true,
          classId: true,
          quizId: true,
          attemptId: true,
          materialId: true,
          materialTitle: true,
          surface: true,
          recommended: true,
          pageStart: true,
          pageEnd: true,
          openedAt: true,
          endedAt: true,
          dwellMs: true,
          activeMs: true,
          clickCount: true,
          pdfOpenCount: true,
          pagesViewed: true,
        },
      }),
      prisma.learningResourceSession.count({ where }),
    ]);
    const materials = await prisma.learningMaterial.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.materialId))] } },
      select: { id: true, title: true, originalName: true },
    });
    const current = new Map(materials.map((m) => [m.id, m]));
    total = count;
    records = rows.map((row) => {
      const material = current.get(row.materialId);
      const pages =
        row.pageStart === null
          ? ""
          : row.pageEnd === null || row.pageEnd === row.pageStart
            ? ` p. ${row.pageStart}`
            : ` pp. ${row.pageStart}–${row.pageEnd}`;
      return {
        id: row.id,
        studentId: row.studentId,
        classId: row.classId,
        quizId: row.quizId,
        attemptId: row.attemptId,
        surface: row.surface,
        title:
          material?.title ||
          material?.originalName ||
          (row.materialTitle
            ? `${row.materialTitle} (removed)`
            : "Removed material"),
        href: material ? `/admin/materials/${row.materialId}` : undefined,
        subtitle: row.recommended
          ? `Recommended${pages}`
          : "Self-directed reading",
        startedAt: row.openedAt,
        completedAt: row.endedAt,
        detail: `${formatDurationMs(row.activeMs)} active / ${formatDurationMs(row.dwellMs)} visible · ${row.pagesViewed} ${row.pagesViewed === 1 ? "page" : "pages"} viewed · ${row.clickCount} clicks · ${row.pdfOpenCount} PDF opens · ${resourceSurfaceLabel(row.surface)}`,
      };
    });
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
          attemptId: true,
          simulationId: true,
          startedAt: true,
          endedAt: true,
          activeMs: true,
          dwellMs: true,
          interactionCount: true,
          paramChanges: true,
          surface: true,
          viewport: true,
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
      detail: `${formatDurationMs(row.activeMs)} active / ${formatDurationMs(row.dwellMs)} open · ${row.interactionCount} interactions · ${row.paramChanges} control changes · ${simulationSurfaceLabel(row.surface)} (${simulationViewportLabel(row.viewport, row.surface)})`,
    }));
  }

  // Resolve only this page's identities. Relation-free records survive deleted accounts/classes.
  const unassignedStudentIds = [
    ...new Set(records.flatMap((row) => (row.classId ? [] : [row.studentId]))),
  ];
  const [students, classes, quizzes, enrollments] = await Promise.all([
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
    // For rows without a class: which classes the student is in today, so a
    // library open isn't mistaken for a student who isn't enrolled anywhere.
    unassignedStudentIds.length > 0
      ? prisma.classEnrollment.findMany({
          where: { studentId: { in: unassignedStudentIds } },
          orderBy: { joinedAt: "asc" },
          select: { studentId: true, class: { select: { name: true } } },
        })
      : [],
  ]);
  const studentNames = new Map(
    students.map((student) => [student.id, student.user]),
  );
  const classNames = new Map(classes.map((cls) => [cls.id, cls.name]));
  const quizNames = new Map(quizzes.map((quiz) => [quiz.id, quiz.name]));
  const enrolledIn = new Map<string, string[]>();
  for (const { studentId: id, class: cls } of enrollments) {
    enrolledIn.set(id, [...(enrolledIn.get(id) ?? []), cls.name]);
  }
  return {
    kind,
    q,
    page,
    total,
    studentId,
    classId,
    records: records.map(({ attemptId, surface, subtitle, ...row }) => {
      const student = studentNames.get(row.studentId);
      const quizName = row.quizId
        ? (quizNames.get(row.quizId) ?? "Deleted quiz")
        : "—";
      const unassigned = row.classId
        ? null
        : unassignedClassLabel({ surface, attemptId });
      const currentClasses = enrolledIn.get(row.studentId);
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
            : unassigned!.label),
        classNote: unassigned
          ? [
              unassigned.note,
              currentClasses
                ? `Student's classes: ${currentClasses.join(", ")}`
                : "Student is not enrolled in any class",
            ]
              .filter(Boolean)
              .join(". ")
          : null,
        classHref:
          row.classId && classNames.has(row.classId)
            ? `/admin/classes/${row.classId}/stats`
            : null,
        quizName,
        subtitle:
          subtitle && row.quizId ? `${subtitle} after ${quizName}` : subtitle,
      };
    }),
  };
}
