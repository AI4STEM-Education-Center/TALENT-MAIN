// Pure helpers for learning-resource engagement telemetry: the closed set of
// surfaces a student can open a material from, the client-side tracker that
// turns DOM activity into cumulative per-open totals, the server-side clamps
// and merge rules, and the aggregations behind the admin/teacher reports.
//
// Everything here is pure (no DB / Next / DOM imports) so it unit-tests like
// simulation-telemetry.ts; the routes live under
// /api/student/materials/[materialId]/sessions and the React hook in
// src/components/student/use-resource-telemetry.ts.
//
// Model: one LearningResourceSession row per OPEN. "Clicks on a resource" are
// therefore the session count, while clickCount is in-viewer interaction.
// Every number is client-reported engagement signal, not ground truth — the
// server clamps and merges monotonically so replays can't inflate it.

import type { StoredRecommendation } from "./exam-results";
import { isAdmin } from "./roles";

// ─── Surfaces ─────────────────────────────────────────────────────────────────

/**
 * Where a material was opened. Each value matches a real launch point:
 *
 * - results_recommendation  the recommended-pages dialog on the results
 *                           shown in place right after submitting a quiz
 *                           (QuizPlayer)
 * - history_recommendation  the same dialog on a saved results page,
 *                           /student/results/[attemptId], which students reach
 *                           from Exam History
 * - materials_library       the page-by-page reader under /student/materials,
 *                           reached from the Course Materials library
 */
export const RESOURCE_SURFACES = [
  "results_recommendation",
  "history_recommendation",
  "materials_library",
] as const;
export type ResourceSurface = (typeof RESOURCE_SURFACES)[number];

/** Human labels for reports and exports. */
export const RESOURCE_SURFACE_LABELS: Record<ResourceSurface, string> = {
  results_recommendation: "Quiz results (recommended)",
  history_recommendation: "Exam history (recommended)",
  materials_library: "Course materials library",
};

/** Label for any stored surface string, tolerating values from older builds. */
export function resourceSurfaceLabel(surface: string): string {
  return (
    (RESOURCE_SURFACE_LABELS as Record<string, string>)[surface] ?? surface
  );
}

/** Surfaces that open a post-quiz recommendation (and must be verified as one). */
export function isRecommendationSurface(surface: ResourceSurface): boolean {
  return (
    surface === "results_recommendation" || surface === "history_recommendation"
  );
}

// ─── Who may see it ───────────────────────────────────────────────────────────

/**
 * Roles allowed to read individual LearningResourceSession data. Rows exist
 * only for students who consented to research, so ANY row shown for a named
 * student reveals their participation — and the consent form promises that
 * participation "will not be known to your course instructor while you are
 * enrolled". Teachers therefore never see per-student (or small-group)
 * resource telemetry; only administrators do for now. Widening this to the
 * research team means switching to canViewAdminData (roles.ts) once
 * RESEARCHER can reach these admin pages. Every read path for per-student
 * data must check this.
 */
export function canViewResourceTelemetry(role: unknown): boolean {
  return isAdmin(role);
}

// ─── Client timing constants ──────────────────────────────────────────────────

/** Activity within this window counts the elapsed time as "active". */
export const RESOURCE_ACTIVE_IDLE_MS = 15_000;
/** How often the client flushes a dirty batch. */
export const RESOURCE_FLUSH_MS = 15_000;
/**
 * The longest stretch a single tracker step may credit. The hook ticks every
 * few seconds, so a larger gap means the device slept or the tab was frozen
 * without a visibilitychange — that time is not reading.
 */
export const RESOURCE_MAX_STEP_MS = 30_000;

// ─── Server clamps ────────────────────────────────────────────────────────────

export const MAX_RESOURCE_MS = 4 * 60 * 60 * 1000; // 4h — a school day's reading
export const MAX_RESOURCE_COUNT = 100_000;
/** Distinct pages kept in pagesViewedJson (longest-viewed win past the cap). */
export const MAX_TRACKED_PAGES = 300;
export const MAX_PAGE_NUMBER = 10_000;
/** Allowance for client/server clock skew when bounding dwell by wall time. */
export const WALL_CLOCK_SLACK_MS = 5_000;

const clampInt = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), max) : 0;

export const clampResourceMs = (value: number): number =>
  clampInt(value, MAX_RESOURCE_MS);
export const clampResourceCount = (value: number): number =>
  clampInt(value, MAX_RESOURCE_COUNT);

/** {pageNumber: visibleMs}, keys are decimal page numbers. */
export type PageDwell = Record<string, number>;

/**
 * Sanitize a client-reported page map: keys must be page numbers in
 * [1, MAX_PAGE_NUMBER] (normalized to their decimal form), values are clamped
 * durations, and at most MAX_TRACKED_PAGES entries survive — the longest-viewed
 * ones, so padding the map with junk pages cannot crowd out the real signal.
 * A zero-ms entry is kept: it still records that the page was shown.
 */
export function sanitizePageDwell(input: Record<string, number>): PageDwell {
  const merged = new Map<number, number>();
  for (const [rawKey, rawMs] of Object.entries(input)) {
    if (!/^\d{1,5}$/.test(rawKey.trim())) continue;
    const page = Number(rawKey.trim());
    if (page < 1 || page > MAX_PAGE_NUMBER) continue;
    const ms = clampResourceMs(rawMs);
    merged.set(page, Math.max(merged.get(page) ?? 0, ms));
  }
  const kept = [...merged.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_TRACKED_PAGES)
    .sort((a, b) => a[0] - b[0]);
  return Object.fromEntries(kept.map(([page, ms]) => [String(page), ms]));
}

/** Safely parse a stored pagesViewedJson blob. */
export function parsePageDwell(raw: string | null): PageDwell {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const pages: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") pages[key] = value;
    }
    return sanitizePageDwell(pages);
  } catch {
    return {};
  }
}

/** Cumulative per-open totals, as stored and as reported by the client. */
export type ResourceTotals = {
  dwellMs: number;
  activeMs: number;
  clickCount: number;
  pdfOpenCount: number;
  pages: PageDwell;
};

/**
 * Merge a client batch into the stored totals.
 *
 * The client reports CUMULATIVE totals, so every field is max(stored,
 * incoming) — a replayed batch or the fetch/beacon race is idempotent and the
 * record never moves backwards. Then the physical bounds are enforced:
 * dwell can't exceed the wall-clock time since the open (plus skew slack),
 * active time can't exceed dwell, and no single page can exceed dwell.
 */
export function mergeResourceTotals(
  stored: ResourceTotals,
  incoming: ResourceTotals,
  elapsedSinceOpenMs: number,
): ResourceTotals & { pagesViewed: number } {
  const wallCap = clampResourceMs(
    Math.max(0, elapsedSinceOpenMs) + WALL_CLOCK_SLACK_MS,
  );
  const dwellMs = Math.min(
    clampResourceMs(Math.max(stored.dwellMs, incoming.dwellMs)),
    Math.max(wallCap, stored.dwellMs),
  );
  const activeMs = Math.min(
    clampResourceMs(Math.max(stored.activeMs, incoming.activeMs)),
    dwellMs,
  );
  const mergedPages: Record<string, number> = { ...stored.pages };
  for (const [page, ms] of Object.entries(incoming.pages)) {
    mergedPages[page] = Math.max(mergedPages[page] ?? 0, ms);
  }
  const pages = sanitizePageDwell(
    Object.fromEntries(
      Object.entries(mergedPages).map(([page, ms]) => [
        page,
        Math.min(ms, dwellMs),
      ]),
    ),
  );
  return {
    dwellMs,
    activeMs,
    clickCount: clampResourceCount(
      Math.max(stored.clickCount, incoming.clickCount),
    ),
    pdfOpenCount: clampResourceCount(
      Math.max(stored.pdfOpenCount, incoming.pdfOpenCount),
    ),
    pages,
    pagesViewed: Object.keys(pages).length,
  };
}

// ─── Recommendation verification ──────────────────────────────────────────────

/**
 * Find the recommendation in an attempt's stored snapshot that this material
 * open corresponds to. Recommendations generated since materialId was added
 * carry it directly; older snapshots only carry page storageKeys, so the
 * caller passes the set of storageKeys that belong to the material and a
 * recommendation matches when any of its pages is one of them.
 */
export function findRecommendationForMaterial(
  items: StoredRecommendation[],
  materialId: string,
  materialPageKeys: ReadonlySet<string>,
): StoredRecommendation | null {
  const byId = items.find((item) => item.materialId === materialId);
  if (byId) return byId;
  return (
    items.find(
      (item) =>
        !item.materialId &&
        Array.isArray(item.pages) &&
        item.pages.some((page) => materialPageKeys.has(page.storageKey)),
    ) ?? null
  );
}

// ─── Client-side tracker ──────────────────────────────────────────────────────

/**
 * Accumulates one open's totals from DOM-derived events, with time injected so
 * it is deterministic under test. The hook calls `tick` on a short interval
 * and before every snapshot; every event method first credits the time since
 * the previous step to the state that held during it.
 *
 * - dwell: time while the viewer is open and the tab is visible
 * - active: the part of dwell within RESOURCE_ACTIVE_IDLE_MS of an activity
 *   (scroll, pointer, key) — reading with no input at all decays to idle
 * - pages: dwell credited to whichever page is currently in view
 */
export class ResourceTelemetryTracker {
  private dwellMs = 0;
  private activeMs = 0;
  private clickCount = 0;
  private pdfOpenCount = 0;
  private readonly pages = new Map<number, number>();
  private currentPage: number | null = null;
  private lastStep: number;
  private lastActivity: number;
  private visible: boolean;

  constructor(now: number, visible: boolean) {
    this.lastStep = now;
    // Opening the viewer is itself an interaction.
    this.lastActivity = now;
    this.visible = visible;
  }

  /** Credit the time since the previous step. */
  tick(now: number): void {
    const elapsed = Math.min(
      Math.max(0, now - this.lastStep),
      RESOURCE_MAX_STEP_MS,
    );
    if (this.visible && elapsed > 0) {
      this.dwellMs += elapsed;
      const activeUntil = this.lastActivity + RESOURCE_ACTIVE_IDLE_MS;
      const activeStart = now - elapsed;
      this.activeMs += Math.max(
        0,
        Math.min(now, activeUntil) - Math.max(activeStart, this.lastActivity),
      );
      if (this.currentPage !== null) {
        this.pages.set(
          this.currentPage,
          (this.pages.get(this.currentPage) ?? 0) + elapsed,
        );
      }
    }
    this.lastStep = Math.max(this.lastStep, now);
  }

  setVisible(visible: boolean, now: number): void {
    this.tick(now);
    this.visible = visible;
    if (visible) this.lastActivity = now;
  }

  /** Scroll / pointer movement / wheel: keeps the reader active. */
  activity(now: number): void {
    this.tick(now);
    this.lastActivity = now;
  }

  /** A pointer or key press inside the viewer. */
  click(now: number): void {
    this.activity(now);
    this.clickCount += 1;
  }

  /**
   * The original PDF was opened. Not a click on its own: the press on the
   * link already reached the viewer's pointer/key listener.
   */
  pdfOpened(now: number): void {
    this.activity(now);
    this.pdfOpenCount += 1;
  }

  /** The page now in view (null: none, e.g. between pages). */
  viewPage(page: number | null, now: number): void {
    this.tick(now);
    this.currentPage = page;
    if (
      page !== null &&
      !this.pages.has(page) &&
      this.pages.size < MAX_TRACKED_PAGES
    ) {
      this.pages.set(page, 0);
    }
  }

  snapshot(now: number): ResourceTotals {
    this.tick(now);
    return {
      dwellMs: Math.round(this.dwellMs),
      activeMs: Math.round(this.activeMs),
      clickCount: this.clickCount,
      pdfOpenCount: this.pdfOpenCount,
      pages: Object.fromEntries(
        [...this.pages.entries()].map(([page, ms]) => [
          String(page),
          Math.round(ms),
        ]),
      ),
    };
  }
}

// ─── Aggregation for reports ──────────────────────────────────────────────────
// The admin report groups in the database (counts, sums, distinct pairs) and
// only pulls narrow duration columns for medians; these pure assemblers turn
// those grouped rows into display rows so the shaping stays unit-testable.

/** Most materials the admin per-material table lists (most-opened first). */
export const MAX_MATERIAL_ROWS = 200;

/** Median via one copy + one numeric sort (typed-array sort, no comparator). */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** One material's totals, as returned by a groupBy on materialId. */
export type MaterialGroup = {
  materialId: string;
  opens: number;
  totalDwellMs: number;
  totalClicks: number;
  lastOpenedAt: Date | null;
};

/** Most-opened first, then most recently opened, then id for stability. */
export function rankMaterialGroups(groups: MaterialGroup[]): MaterialGroup[] {
  return groups.toSorted(
    (a, b) =>
      b.opens - a.opens ||
      (b.lastOpenedAt?.getTime() ?? 0) - (a.lastOpenedAt?.getTime() ?? 0) ||
      a.materialId.localeCompare(b.materialId),
  );
}

export type MaterialBreakdown = {
  /** One entry per distinct (material, student) pair. */
  studentPairs: { materialId: string }[];
  recommended: { materialId: string; count: number }[];
  surfaces: { materialId: string; surface: string; count: number }[];
  /** Narrow per-session duration columns, for medians. */
  durations: { materialId: string; dwellMs: number; activeMs: number }[];
  /** Display title per material (live title, else newest snapshot). */
  titles: Map<string, string>;
};

export type ResourceEngagementRow = {
  materialId: string;
  title: string;
  opens: number;
  uniqueStudents: number;
  recommendedOpens: number;
  selfDirectedOpens: number;
  totalDwellMs: number;
  medianDwellMs: number;
  medianActiveMs: number;
  totalClicks: number;
  bySurface: Record<string, number>;
  lastOpenedAt: Date | null;
};

const countBy = <T>(
  rows: T[],
  key: (row: T) => string,
  n: (row: T) => number,
) => {
  const out = new Map<string, number>();
  for (const row of rows) out.set(key(row), (out.get(key(row)) ?? 0) + n(row));
  return out;
};

/**
 * Append to a Map-of-arrays in place. The report folds tens of thousands of
 * duration rows; copying the accumulated array per row (spread/concat) made
 * assembly quadratic and blocked the event loop for seconds.
 */
function pushInto(map: Map<string, number[]>, key: string, value: number) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Combine grouped rows into one display row per material, in `groups` order. */
export function assembleMaterialRows(
  groups: MaterialGroup[],
  breakdown: MaterialBreakdown,
): ResourceEngagementRow[] {
  const students = countBy(
    breakdown.studentPairs,
    (r) => r.materialId,
    () => 1,
  );
  const recommended = countBy(
    breakdown.recommended,
    (r) => r.materialId,
    (r) => r.count,
  );
  const surfaces = new Map<string, Record<string, number>>();
  for (const row of breakdown.surfaces) {
    const entry = surfaces.get(row.materialId) ?? {};
    entry[row.surface] = (entry[row.surface] ?? 0) + row.count;
    surfaces.set(row.materialId, entry);
  }
  const dwell = new Map<string, number[]>();
  const active = new Map<string, number[]>();
  for (const row of breakdown.durations) {
    pushInto(dwell, row.materialId, row.dwellMs);
    pushInto(active, row.materialId, row.activeMs);
  }
  return groups.map((group) => {
    const recommendedOpens = recommended.get(group.materialId) ?? 0;
    return {
      materialId: group.materialId,
      title: breakdown.titles.get(group.materialId) ?? "Removed material",
      opens: group.opens,
      uniqueStudents: students.get(group.materialId) ?? 0,
      recommendedOpens,
      selfDirectedOpens: group.opens - recommendedOpens,
      totalDwellMs: group.totalDwellMs,
      medianDwellMs: medianOf(dwell.get(group.materialId) ?? []),
      medianActiveMs: medianOf(active.get(group.materialId) ?? []),
      totalClicks: group.totalClicks,
      bySurface: surfaces.get(group.materialId) ?? {},
      lastOpenedAt: group.lastOpenedAt,
    };
  });
}

export type ResourceSurfaceRow = {
  surface: string;
  label: string;
  opens: number;
  uniqueStudents: number;
  medianDwellMs: number;
  totalClicks: number;
};

/** One row per surface, in RESOURCE_SURFACES order (unknown values last). */
export function assembleSurfaceRows(
  groups: { surface: string; opens: number; totalClicks: number }[],
  studentPairs: { surface: string }[],
  durations: { surface: string; dwellMs: number }[],
): ResourceSurfaceRow[] {
  const students = countBy(
    studentPairs,
    (r) => r.surface,
    () => 1,
  );
  const dwell = new Map<string, number[]>();
  for (const row of durations) pushInto(dwell, row.surface, row.dwellMs);
  const order = (surface: string) => {
    const index = (RESOURCE_SURFACES as readonly string[]).indexOf(surface);
    return index === -1 ? RESOURCE_SURFACES.length : index;
  };
  return groups
    .map((group) => ({
      surface: group.surface,
      label: resourceSurfaceLabel(group.surface),
      opens: group.opens,
      uniqueStudents: students.get(group.surface) ?? 0,
      medianDwellMs: medianOf(dwell.get(group.surface) ?? []),
      totalClicks: group.totalClicks,
    }))
    .toSorted(
      (a, b) =>
        order(a.surface) - order(b.surface) ||
        a.surface.localeCompare(b.surface),
    );
}
