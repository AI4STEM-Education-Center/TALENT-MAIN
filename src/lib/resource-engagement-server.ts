import { prisma } from "@/lib/prisma";
import {
  MAX_MATERIAL_ROWS,
  assembleMaterialRows,
  assembleSurfaceRows,
  rankMaterialGroups,
  resourceSurfaceLabel,
  canViewResourceTelemetry,
  type ResourceEngagementRow,
  type ResourceSurfaceRow,
} from "@/lib/resource-telemetry";

/**
 * Read models over LearningResourceSession for the admin engagement page and
 * the admin per-student stats card. Rows exist only for consenting students
 * (the routes gate on research consent), so every read here is for viewers
 * with research access (canViewResourceTelemetry) — never teachers. Shaping
 * lives in the pure resource-telemetry.ts; this file does the Prisma side.
 */

/** Current display titles for materials that still exist. */
async function liveMaterialTitles(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const materials = await prisma.learningMaterial.findMany({
    where: { id: { in: unique } },
    select: { id: true, title: true, originalName: true },
  });
  return new Map(
    materials.map((m) => [m.id, m.title?.trim() || m.originalName]),
  );
}

/** Report windows offered on the admin page; "all" means no lower bound. */
export const ENGAGEMENT_RANGES = {
  "7": "Last 7 days",
  "30": "Last 30 days",
  "90": "Last 90 days",
  all: "All time",
} as const;
export type EngagementRange = keyof typeof ENGAGEMENT_RANGES;

export function parseEngagementRange(value: unknown): EngagementRange {
  return typeof value === "string" && value in ENGAGEMENT_RANGES
    ? (value as EngagementRange)
    : "30";
}

export type AdminResourceEngagement = {
  range: EngagementRange;
  opens: number;
  uniqueStudents: number;
  recommendedOpens: number;
  totalDwellMs: number;
  totalClicks: number;
  /** Materials with any open in the window (the table shows the top ones). */
  materialCount: number;
  materials: ResourceEngagementRow[];
  surfaces: ResourceSurfaceRow[];
};

/**
 * Every material's engagement across all classes, for the admin report.
 *
 * Counts, sums and distinct (material|surface, student) pairs are grouped in
 * SQLite (the window filter uses the openedAt index); only the narrow
 * duration columns are read for medians, and per-material detail is limited
 * to the MAX_MATERIAL_ROWS most-opened materials.
 */
export async function getAdminResourceEngagement(
  range: EngagementRange,
  now: Date = new Date(),
): Promise<AdminResourceEngagement> {
  const since =
    range === "all"
      ? undefined
      : new Date(now.getTime() - Number(range) * 24 * 60 * 60 * 1000);
  const where = since ? { openedAt: { gte: since } } : {};
  const db = prisma.learningResourceSession;

  const [
    totals,
    students,
    recommendedOpens,
    materialGroups,
    surfaceGroups,
    surfaceStudents,
    surfaceDurations,
  ] = await Promise.all([
    db.aggregate({
      where,
      _count: { _all: true },
      _sum: { dwellMs: true, clickCount: true },
    }),
    db.groupBy({ by: ["studentId"], where }),
    db.count({ where: { ...where, recommended: true } }),
    db.groupBy({
      by: ["materialId"],
      where,
      _count: { _all: true },
      _sum: { dwellMs: true, clickCount: true },
      _max: { openedAt: true },
    }),
    db.groupBy({
      by: ["surface"],
      where,
      _count: { _all: true },
      _sum: { clickCount: true },
    }),
    db.groupBy({ by: ["surface", "studentId"], where }),
    db.findMany({ where, select: { surface: true, dwellMs: true } }),
  ]);

  const top = rankMaterialGroups(
    materialGroups.map((g) => ({
      materialId: g.materialId,
      opens: g._count._all,
      totalDwellMs: g._sum.dwellMs ?? 0,
      totalClicks: g._sum.clickCount ?? 0,
      lastOpenedAt: g._max.openedAt,
    })),
  ).slice(0, MAX_MATERIAL_ROWS);
  const topIds = top.map((g) => g.materialId);
  const topWhere = { ...where, materialId: { in: topIds } };

  const [studentPairs, recommended, surfaces, durations, titles] =
    await Promise.all([
      db.groupBy({ by: ["materialId", "studentId"], where: topWhere }),
      db.groupBy({
        by: ["materialId"],
        where: { ...topWhere, recommended: true },
        _count: { _all: true },
      }),
      db.groupBy({
        by: ["materialId", "surface"],
        where: topWhere,
        _count: { _all: true },
      }),
      db.findMany({
        where: topWhere,
        select: { materialId: true, dwellMs: true, activeMs: true },
      }),
      materialTitles(topIds),
    ]);

  return {
    range,
    opens: totals._count._all,
    uniqueStudents: students.length,
    recommendedOpens,
    totalDwellMs: totals._sum.dwellMs ?? 0,
    totalClicks: totals._sum.clickCount ?? 0,
    materialCount: materialGroups.length,
    materials: assembleMaterialRows(top, {
      studentPairs,
      recommended: recommended.map((r) => ({
        materialId: r.materialId,
        count: r._count._all,
      })),
      surfaces: surfaces.map((s) => ({
        materialId: s.materialId,
        surface: s.surface,
        count: s._count._all,
      })),
      durations,
      titles,
    }),
    surfaces: assembleSurfaceRows(
      surfaceGroups.map((g) => ({
        surface: g.surface,
        opens: g._count._all,
        totalClicks: g._sum.clickCount ?? 0,
      })),
      surfaceStudents,
      surfaceDurations,
    ),
  };
}

/**
 * Display titles: the live material title, else the newest title snapshot
 * recorded on its sessions (materials deleted since still report by name).
 */
async function materialTitles(ids: string[]): Promise<Map<string, string>> {
  const titles = await liveMaterialTitles(ids);
  const missing = ids.filter((id) => !titles.has(id));
  if (missing.length > 0) {
    const snapshots = await prisma.learningResourceSession.findMany({
      where: { materialId: { in: missing }, materialTitle: { not: null } },
      orderBy: { openedAt: "desc" },
      distinct: ["materialId"],
      select: { materialId: true, materialTitle: true },
    });
    for (const s of snapshots) titles.set(s.materialId, s.materialTitle!);
  }
  return titles;
}

export type StudentResourceSessionRow = {
  sessionId: string;
  title: string;
  surfaceLabel: string;
  recommended: boolean;
  pageRange: string | null;
  openedAt: Date;
  dwellMs: number;
  activeMs: number;
  clickCount: number;
  pagesViewed: number;
};

/**
 * A student's recent material opens in one class, newest first — for viewers
 * with research access only (see canViewResourceTelemetry). Anyone else gets
 * an empty list WITHOUT the table being queried, so a teacher's request can
 * never load (or leak into a payload) a consenting student's rows.
 *
 * A session belongs to the class when it was recorded with that classId, or —
 * for a library open of a material shared with several of the student's
 * classes (classId null) — when the material is shared with this class.
 */
export async function getStudentResourceSessions(
  viewer: { role: string | null | undefined },
  classId: string,
  studentId: string,
  limit = 50,
): Promise<StudentResourceSessionRow[]> {
  if (!canViewResourceTelemetry(viewer.role)) return [];
  const classMaterialIds = (
    await prisma.materialClass.findMany({
      where: { classId },
      select: { materialId: true },
    })
  ).map((link) => link.materialId);
  const sessions = await prisma.learningResourceSession.findMany({
    where: {
      studentId,
      OR: [
        { classId },
        { classId: null, materialId: { in: classMaterialIds } },
      ],
    },
    orderBy: { openedAt: "desc" },
    take: limit,
  });
  const titles = await liveMaterialTitles(sessions.map((s) => s.materialId));
  return sessions.map((s) => ({
    sessionId: s.id,
    title: titles.get(s.materialId) ?? s.materialTitle ?? "Removed material",
    surfaceLabel: resourceSurfaceLabel(s.surface),
    recommended: s.recommended,
    pageRange:
      s.pageStart === null
        ? null
        : s.pageEnd === null || s.pageEnd === s.pageStart
          ? `p. ${s.pageStart}`
          : `pp. ${s.pageStart}–${s.pageEnd}`,
    openedAt: s.openedAt,
    dwellMs: s.dwellMs,
    activeMs: s.activeMs,
    clickCount: s.clickCount,
    pagesViewed: s.pagesViewed,
  }));
}
