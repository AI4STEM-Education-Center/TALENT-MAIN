import { prisma } from "@/lib/prisma";
import {
  summarizeResourceEngagement,
  summarizeResourceSurfaces,
  resourceSurfaceLabel,
  type ResourceEngagementRow,
  type ResourceSurfaceRow,
} from "@/lib/resource-telemetry";

/**
 * Read models over LearningResourceSession for the admin engagement page and
 * the teacher/admin per-student stats page. Aggregation is in the pure
 * resource-telemetry.ts; this file only does the Prisma assembly. Rows exist
 * only for consenting students (the routes gate on research consent), the
 * same population SimulationSession reports cover.
 */

const SESSION_SELECT = {
  materialId: true,
  materialTitle: true,
  studentId: true,
  surface: true,
  recommended: true,
  openedAt: true,
  dwellMs: true,
  activeMs: true,
  clickCount: true,
} as const;

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
  materials: ResourceEngagementRow[];
  surfaces: ResourceSurfaceRow[];
};

/** Every material's engagement across all classes, for the admin report. */
export async function getAdminResourceEngagement(
  range: EngagementRange,
  now: Date = new Date(),
): Promise<AdminResourceEngagement> {
  const since =
    range === "all"
      ? undefined
      : new Date(now.getTime() - Number(range) * 24 * 60 * 60 * 1000);
  const sessions = await prisma.learningResourceSession.findMany({
    where: since ? { openedAt: { gte: since } } : {},
    select: SESSION_SELECT,
  });
  const titles = await liveMaterialTitles(sessions.map((s) => s.materialId));
  return {
    range,
    opens: sessions.length,
    uniqueStudents: new Set(sessions.map((s) => s.studentId)).size,
    recommendedOpens: sessions.filter((s) => s.recommended).length,
    totalDwellMs: sessions.reduce((sum, s) => sum + s.dwellMs, 0),
    totalClicks: sessions.reduce((sum, s) => sum + s.clickCount, 0),
    materials: summarizeResourceEngagement(sessions, titles),
    surfaces: summarizeResourceSurfaces(sessions),
  };
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
 * A student's recent material opens in one class, newest first. A session
 * belongs to the class when it was recorded with that classId, or — for a
 * library open of a material shared with several of the student's classes
 * (classId null) — when the material is shared with this class. Either way
 * the material is this class's, so a teacher only ever sees reading of their
 * own class's content, mirroring getStudentSimulationSessions.
 */
export async function getStudentResourceSessions(
  classId: string,
  studentId: string,
  limit = 50,
): Promise<StudentResourceSessionRow[]> {
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
