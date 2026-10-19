import { describe, expect, it } from "vitest";
import {
  MAX_PAGE_NUMBER,
  MAX_RESOURCE_MS,
  MAX_TRACKED_PAGES,
  RESOURCE_ACTIVE_IDLE_MS,
  RESOURCE_MAX_STEP_MS,
  RESOURCE_SURFACES,
  RESOURCE_SURFACE_LABELS,
  ResourceTelemetryTracker,
  WALL_CLOCK_SLACK_MS,
  findRecommendationForMaterial,
  isRecommendationSurface,
  mergeResourceTotals,
  parsePageDwell,
  resourceSurfaceLabel,
  sanitizePageDwell,
  assembleMaterialRows,
  assembleSurfaceRows,
  canViewResourceTelemetry,
  medianOf,
  rankMaterialGroups,
  type ResourceTotals,
} from "./resource-telemetry";
import type { StoredRecommendation } from "./exam-results";

const zero: ResourceTotals = {
  dwellMs: 0,
  activeMs: 0,
  clickCount: 0,
  pdfOpenCount: 0,
  pages: {},
};

describe("surfaces", () => {
  it("labels every surface and passes unknown values through", () => {
    for (const surface of RESOURCE_SURFACES) {
      expect(RESOURCE_SURFACE_LABELS[surface]).toBeTruthy();
      expect(resourceSurfaceLabel(surface)).toBe(
        RESOURCE_SURFACE_LABELS[surface],
      );
    }
    expect(resourceSurfaceLabel("legacy_surface")).toBe("legacy_surface");
  });

  it("treats only the results surfaces as recommendations", () => {
    expect(isRecommendationSurface("results_recommendation")).toBe(true);
    expect(isRecommendationSurface("history_recommendation")).toBe(true);
    expect(isRecommendationSurface("materials_library")).toBe(false);
  });
});

describe("sanitizePageDwell / parsePageDwell", () => {
  it("keeps valid page numbers, normalizes keys and clamps values", () => {
    expect(
      sanitizePageDwell({
        "3": 1500,
        "04": 200,
        "0": 10,
        "-1": 10,
        abc: 10,
        "1.5": 10,
        [String(MAX_PAGE_NUMBER + 1)]: 10,
        "7": MAX_RESOURCE_MS * 10,
        "8": -50,
      }),
    ).toEqual({ "3": 1500, "4": 200, "7": MAX_RESOURCE_MS, "8": 0 });
  });

  it("caps the entry count keeping the longest-viewed pages", () => {
    const input: Record<string, number> = {};
    for (let page = 1; page <= MAX_TRACKED_PAGES + 50; page += 1)
      input[String(page)] = page;
    const kept = sanitizePageDwell(input);
    expect(Object.keys(kept)).toHaveLength(MAX_TRACKED_PAGES);
    expect(kept["1"]).toBeUndefined();
    expect(kept[String(MAX_TRACKED_PAGES + 50)]).toBe(MAX_TRACKED_PAGES + 50);
  });

  it("parses stored JSON defensively", () => {
    expect(parsePageDwell(null)).toEqual({});
    expect(parsePageDwell("not json")).toEqual({});
    expect(parsePageDwell("[1,2]")).toEqual({});
    expect(parsePageDwell('{"2":100,"x":5,"3":"7"}')).toEqual({ "2": 100 });
  });
});

describe("mergeResourceTotals", () => {
  it("takes the per-field max so replays and races are idempotent", () => {
    const stored = {
      dwellMs: 10_000,
      activeMs: 4_000,
      clickCount: 5,
      pdfOpenCount: 1,
      pages: { "1": 6_000, "2": 4_000 },
    };
    const stale = {
      dwellMs: 8_000,
      activeMs: 3_000,
      clickCount: 3,
      pdfOpenCount: 0,
      pages: { "1": 5_000 },
    };
    const merged = mergeResourceTotals(stored, stale, 60_000);
    expect(merged).toEqual({ ...stored, pagesViewed: 2 });
    expect(mergeResourceTotals(merged, stale, 60_000)).toEqual(merged);
  });

  it("bounds dwell by wall-clock time since open, active and pages by dwell", () => {
    const merged = mergeResourceTotals(
      zero,
      {
        dwellMs: 3_600_000,
        activeMs: 3_600_000,
        clickCount: 2,
        pdfOpenCount: 0,
        pages: { "5": 3_600_000 },
      },
      10_000,
    );
    expect(merged.dwellMs).toBe(10_000 + WALL_CLOCK_SLACK_MS);
    expect(merged.activeMs).toBe(merged.dwellMs);
    expect(merged.pages).toEqual({ "5": merged.dwellMs });
    expect(merged.pagesViewed).toBe(1);
  });

  it("never lowers an already-stored dwell even with skewed clocks", () => {
    const merged = mergeResourceTotals(
      { ...zero, dwellMs: 50_000, activeMs: 10_000 },
      { ...zero, dwellMs: 60_000 },
      -1_000,
    );
    expect(merged.dwellMs).toBe(50_000);
    expect(merged.activeMs).toBe(10_000);
  });
});

describe("findRecommendationForMaterial", () => {
  const rec = (
    title: string,
    keys: string[],
    materialId?: string,
  ): StoredRecommendation => ({
    ...(materialId ? { materialId } : {}),
    materialTitle: title,
    pageRange: { start: 1, end: keys.length },
    reason: "",
    pages: keys.map((storageKey, i) => ({ pageNumber: i + 1, storageKey })),
  });

  it("matches by stored materialId first", () => {
    const items = [rec("A", ["a1"], "mat-a"), rec("B", ["b1"], "mat-b")];
    expect(
      findRecommendationForMaterial(items, "mat-b", new Set())?.materialTitle,
    ).toBe("B");
  });

  it("falls back to page storageKeys for legacy snapshots", () => {
    const items = [rec("Legacy", ["k1", "k2"])];
    expect(
      findRecommendationForMaterial(items, "mat-x", new Set(["k2"]))
        ?.materialTitle,
    ).toBe("Legacy");
    expect(findRecommendationForMaterial(items, "mat-x", new Set())).toBeNull();
  });

  it("does not let a page-key match override a different stored materialId", () => {
    const items = [rec("Other", ["k1"], "mat-other")];
    expect(
      findRecommendationForMaterial(items, "mat-x", new Set(["k1"])),
    ).toBeNull();
  });
});

describe("ResourceTelemetryTracker", () => {
  it("accrues dwell only while visible and pauses while hidden", () => {
    const t = new ResourceTelemetryTracker(0, true);
    t.tick(5_000);
    t.setVisible(false, 6_000);
    t.tick(20_000);
    t.setVisible(true, 60_000);
    t.tick(61_000);
    expect(t.snapshot(61_000).dwellMs).toBe(7_000);
  });

  it("counts time as active only within the idle window of an activity", () => {
    const t = new ResourceTelemetryTracker(0, true);
    // Opening counts as activity, then no input for a while.
    for (let now = 5_000; now <= 25_000; now += 5_000) t.tick(now);
    expect(t.snapshot(25_000)).toMatchObject({
      dwellMs: 25_000,
      activeMs: RESOURCE_ACTIVE_IDLE_MS,
    });
    t.activity(26_000);
    t.tick(30_000);
    const snap = t.snapshot(30_000);
    expect(snap.activeMs).toBe(RESOURCE_ACTIVE_IDLE_MS + 4_000);
  });

  it("does not credit a gap longer than the max step (device sleep)", () => {
    const t = new ResourceTelemetryTracker(0, true);
    t.tick(10 * 60_000);
    expect(t.snapshot(10 * 60_000).dwellMs).toBe(RESOURCE_MAX_STEP_MS);
  });

  it("counts clicks and PDF opens separately and attributes time to pages", () => {
    const t = new ResourceTelemetryTracker(0, true);
    t.viewPage(3, 0);
    t.click(2_000);
    t.viewPage(4, 4_000);
    t.click(5_000);
    t.pdfOpened(5_000);
    t.viewPage(null, 9_000);
    const snap = t.snapshot(10_000);
    expect(snap).toEqual({
      dwellMs: 10_000,
      activeMs: 10_000,
      clickCount: 2,
      pdfOpenCount: 1,
      pages: { "3": 4_000, "4": 5_000 },
    });
  });
});

describe("canViewResourceTelemetry", () => {
  it("admits the research team only — never teachers or students", () => {
    expect(canViewResourceTelemetry("ADMIN")).toBe(true);
    expect(canViewResourceTelemetry("TEACHER")).toBe(false);
    expect(canViewResourceTelemetry("RESEARCHER")).toBe(true);
    expect(canViewResourceTelemetry("STUDENT")).toBe(false);
    expect(canViewResourceTelemetry(null)).toBe(false);
    expect(canViewResourceTelemetry(undefined)).toBe(false);
  });
});

describe("report assembly", () => {
  const at = (iso: string) => new Date(iso);

  it("computes medians", () => {
    expect(medianOf([])).toBe(0);
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });

  it("ranks material groups by opens, then recency", () => {
    const ranked = rankMaterialGroups([
      {
        materialId: "a",
        opens: 1,
        totalDwellMs: 0,
        totalClicks: 0,
        lastOpenedAt: at("2026-10-05T00:00:00Z"),
      },
      {
        materialId: "b",
        opens: 3,
        totalDwellMs: 0,
        totalClicks: 0,
        lastOpenedAt: at("2026-10-01T00:00:00Z"),
      },
      {
        materialId: "c",
        opens: 1,
        totalDwellMs: 0,
        totalClicks: 0,
        lastOpenedAt: at("2026-10-06T00:00:00Z"),
      },
    ]);
    expect(ranked.map((g) => g.materialId)).toEqual(["b", "c", "a"]);
  });

  it("combines grouped rows into per-material rows", () => {
    const [m1, m2] = assembleMaterialRows(
      [
        {
          materialId: "m1",
          opens: 3,
          totalDwellMs: 60_000,
          totalClicks: 4,
          lastOpenedAt: at("2026-10-03T10:00:00Z"),
        },
        {
          materialId: "m2",
          opens: 1,
          totalDwellMs: 1_000,
          totalClicks: 9,
          lastOpenedAt: null,
        },
      ],
      {
        studentPairs: [
          { materialId: "m1" },
          { materialId: "m1" },
          { materialId: "m2" },
        ],
        recommended: [{ materialId: "m1", count: 2 }],
        surfaces: [
          { materialId: "m1", surface: "results_recommendation", count: 1 },
          { materialId: "m1", surface: "history_recommendation", count: 1 },
          { materialId: "m1", surface: "materials_library", count: 1 },
          { materialId: "m2", surface: "materials_library", count: 1 },
        ],
        durations: [
          { materialId: "m1", dwellMs: 10_000, activeMs: 5_000 },
          { materialId: "m1", dwellMs: 30_000, activeMs: 15_000 },
          { materialId: "m1", dwellMs: 20_000, activeMs: 1_000 },
          { materialId: "m2", dwellMs: 1_000, activeMs: 1_000 },
        ],
        titles: new Map([["m1", "Kinematics"]]),
      },
    );
    expect(m1).toEqual({
      materialId: "m1",
      title: "Kinematics",
      opens: 3,
      uniqueStudents: 2,
      recommendedOpens: 2,
      selfDirectedOpens: 1,
      totalDwellMs: 60_000,
      medianDwellMs: 20_000,
      medianActiveMs: 5_000,
      totalClicks: 4,
      bySurface: {
        results_recommendation: 1,
        history_recommendation: 1,
        materials_library: 1,
      },
      lastOpenedAt: at("2026-10-03T10:00:00Z"),
    });
    expect(m2).toMatchObject({
      title: "Removed material",
      recommendedOpens: 0,
      selfDirectedOpens: 1,
      uniqueStudents: 1,
    });
  });

  it("assembles surfaces in their canonical order", () => {
    const rows = assembleSurfaceRows(
      [
        { surface: "materials_library", opens: 2, totalClicks: 10 },
        { surface: "legacy", opens: 1, totalClicks: 0 },
        { surface: "results_recommendation", opens: 1, totalClicks: 3 },
      ],
      [
        { surface: "materials_library" },
        { surface: "materials_library" },
        { surface: "results_recommendation" },
      ],
      [
        { surface: "materials_library", dwellMs: 1_000 },
        { surface: "materials_library", dwellMs: 3_000 },
        { surface: "results_recommendation", dwellMs: 10_000 },
      ],
    );
    expect(
      rows.map((r) => [r.surface, r.opens, r.uniqueStudents, r.medianDwellMs]),
    ).toEqual([
      ["results_recommendation", 1, 1, 10_000],
      ["materials_library", 2, 2, 2_000],
      ["legacy", 1, 0, 0],
    ]);
    expect(rows[2].label).toBe("legacy");
  });
});

describe("report assembly performance", () => {
  // Regression guard: per-row array copies made assembly quadratic (~16s for
  // 40k sessions of one material). Linear assembly does 50k in milliseconds;
  // the 1s budget leaves ample headroom for slow CI machines.
  const N = 50_000;

  it("assembles 50k sessions of one material well under a second", () => {
    const durations = Array.from({ length: N }, (_, i) => ({
      materialId: "m1",
      dwellMs: (i * 7919) % 600_000,
      activeMs: (i * 104_729) % 300_000,
    }));
    const started = performance.now();
    const [row] = assembleMaterialRows(
      [
        {
          materialId: "m1",
          opens: N,
          totalDwellMs: 0,
          totalClicks: 0,
          lastOpenedAt: null,
        },
      ],
      {
        studentPairs: [],
        recommended: [],
        surfaces: [],
        durations,
        titles: new Map(),
      },
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    const sorted = durations.map((d) => d.dwellMs).sort((a, b) => a - b);
    expect(row.medianDwellMs).toBe((sorted[N / 2 - 1] + sorted[N / 2]) / 2);
  });

  it("assembles 50k sessions of one surface well under a second", () => {
    const durations = Array.from({ length: N }, (_, i) => ({
      surface: "materials_library",
      dwellMs: (i * 7919) % 600_000,
    }));
    const started = performance.now();
    const [row] = assembleSurfaceRows(
      [{ surface: "materials_library", opens: N, totalClicks: 0 }],
      [],
      durations,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(row.opens).toBe(N);
  });
});
