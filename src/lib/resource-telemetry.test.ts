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
  summarizeResourceEngagement,
  summarizeResourceSurfaces,
  type ResourceSessionRecord,
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

describe("summaries", () => {
  const at = (iso: string) => new Date(iso);
  const sessions: ResourceSessionRecord[] = [
    {
      materialId: "m1",
      materialTitle: "Old name",
      studentId: "s1",
      surface: "results_recommendation",
      recommended: true,
      openedAt: at("2026-10-01T10:00:00Z"),
      dwellMs: 10_000,
      activeMs: 5_000,
      clickCount: 3,
    },
    {
      materialId: "m1",
      materialTitle: "New name",
      studentId: "s1",
      surface: "materials_library",
      recommended: false,
      openedAt: at("2026-10-02T10:00:00Z"),
      dwellMs: 30_000,
      activeMs: 15_000,
      clickCount: 1,
    },
    {
      materialId: "m1",
      materialTitle: null,
      studentId: "s2",
      surface: "history_recommendation",
      recommended: true,
      openedAt: at("2026-10-03T10:00:00Z"),
      dwellMs: 20_000,
      activeMs: 1_000,
      clickCount: 0,
    },
    {
      materialId: "m2",
      materialTitle: "Gone",
      studentId: "s3",
      surface: "materials_library",
      recommended: false,
      openedAt: at("2026-10-01T09:00:00Z"),
      dwellMs: 1_000,
      activeMs: 1_000,
      clickCount: 9,
    },
  ];

  it("folds one row per material with recommended/self-directed and surface splits", () => {
    const [m1, m2] = summarizeResourceEngagement(sessions);
    expect(m1).toMatchObject({
      materialId: "m1",
      title: "New name",
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
        materials_library: 1,
        history_recommendation: 1,
      },
      lastOpenedAt: at("2026-10-03T10:00:00Z"),
    });
    expect(m2.title).toBe("Gone");
  });

  it("prefers live titles when the material still exists", () => {
    const rows = summarizeResourceEngagement(
      sessions,
      new Map([["m1", "Live title"]]),
    );
    expect(rows[0].title).toBe("Live title");
  });

  it("summarizes surfaces in their canonical order", () => {
    expect(
      summarizeResourceSurfaces(sessions).map((r) => [r.surface, r.opens]),
    ).toEqual([
      ["results_recommendation", 1],
      ["history_recommendation", 1],
      ["materials_library", 2],
    ]);
  });
});
