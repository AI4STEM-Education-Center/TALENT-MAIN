import { describe, expect, it } from "vitest";
import {
  RECORDING_MAX_EVENTS_PER_CHUNK,
  buildTimeline,
  areaForPath,
  areasInEvents,
  buildAreaSegments,
  isReplayArea,
  canViewSessionRecordings,
  displayPath,
  eventTimeRange,
  formatOffset,
  hasFullSnapshot,
  validateReplayEvents,
  type ReplayEvent,
} from "./session-recording";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const ev = (offset: number, type: number, data?: unknown): ReplayEvent => ({
  type,
  timestamp: T0 + offset,
  data,
});
const custom = (offset: number, tag: string, payload: unknown) =>
  ev(offset, 5, { tag, payload });

describe("validateReplayEvents", () => {
  it("accepts a well-formed batch", () => {
    const events = [ev(0, 4, { href: "https://x/y" }), ev(5, 2, {})];
    expect(validateReplayEvents(events)).toEqual(events);
  });

  it.each([
    ["not an array", {}],
    ["empty", []],
    ["a non-object event", [1]],
    ["an unknown type", [{ type: 9, timestamp: T0 }]],
    ["a fractional type", [{ type: 2.5, timestamp: T0 }]],
    ["a missing timestamp", [{ type: 2 }]],
    ["a timestamp in 1970", [{ type: 2, timestamp: 5 }]],
    ["a NaN timestamp", [{ type: 2, timestamp: NaN }]],
    ["a string data field", [{ type: 2, timestamp: T0, data: "x" }]],
    ["a null data field", [{ type: 2, timestamp: T0, data: null }]],
  ])("rejects %s", (_name, value) => {
    expect(validateReplayEvents(value)).toBeNull();
  });

  it("rejects an oversized batch", () => {
    const big = Array.from({ length: RECORDING_MAX_EVENTS_PER_CHUNK + 1 }, () =>
      ev(0, 3, {}),
    );
    expect(validateReplayEvents(big)).toBeNull();
  });
});

describe("batch helpers", () => {
  it("finds the time range and the opening snapshot", () => {
    const events = [ev(20, 3), ev(5, 2), ev(90, 3)];
    expect(eventTimeRange(events)).toEqual({ first: T0 + 5, last: T0 + 90 });
    expect(hasFullSnapshot(events)).toBe(true);
    expect(hasFullSnapshot([ev(0, 3)])).toBe(false);
  });
});

describe("buildTimeline", () => {
  it("turns labeled custom events into readable entries", () => {
    const { entries, stats } = buildTimeline([
      ev(0, 4, { href: "https://site.test/student/results?x=1" }),
      ev(0, 2, {}),
      custom(1_000, "click", { label: "Submit", tag: "button" }),
      custom(2_000, "input", { label: "Search", value: "forces" }),
      custom(2_500, "input", { label: "Agree" }),
      custom(3_000, "navigate", { path: "/student/history" }),
      custom(4_000, "action", {
        name: "Opened simulation",
        detail: "Pendulum",
      }),
      custom(5_000, "submit", { label: "quiz form" }),
    ]);

    expect(entries.map((entry) => [entry.kind, entry.label])).toEqual([
      ["page", "Opened /student/results?x=1"],
      ["click", "Clicked Submit"],
      ["input", 'Entered "forces" in Search'],
      ["input", "Changed Agree"],
      ["page", "Went to /student/history"],
      ["action", "Opened simulation"],
      ["action", "Submitted quiz form"],
    ]);
    expect(entries[1].offsetMs).toBe(1_000);
    expect(entries[5].detail).toBe("Pendulum");
    expect(stats).toMatchObject({
      durationMs: 5_000,
      clicks: 1,
      inputs: 2,
      pages: 2,
    });
  });

  it("coalesces a burst of scrolling and counts mouse movement", () => {
    const scroll = (offset: number, y: number) =>
      ev(offset, 3, { source: 3, id: 1, x: 0, y });
    const { entries, stats } = buildTimeline([
      ev(0, 2, {}),
      scroll(100, 10),
      scroll(400, 200),
      scroll(800, 640),
      scroll(5_000, 900),
      ev(6_000, 3, { source: 1, positions: [{}, {}, {}] }),
      ev(7_000, 3, { source: 4, width: 800, height: 600 }),
    ]);

    expect(entries.map((entry) => entry.label)).toEqual([
      "Scrolled to 640px",
      "Scrolled to 900px",
      "Window resized to 800×600",
    ]);
    expect(stats.scrolls).toBe(4);
    expect(stats.mouseMoves).toBe(3);
  });

  it("skips malformed events instead of throwing", () => {
    const events = [
      ev(0, 2, {}),
      null,
      { type: 5, timestamp: T0 + 10, data: null },
      custom(20, "click", null),
      custom(30, "navigate", { path: 5 }),
    ] as unknown as ReplayEvent[];
    const { entries } = buildTimeline(events);
    expect(entries.map((entry) => entry.label)).toEqual(["Clicked an element"]);
  });

  it("handles an empty recording", () => {
    expect(buildTimeline([])).toEqual({
      entries: [],
      stats: {
        durationMs: 0,
        clicks: 0,
        inputs: 0,
        scrolls: 0,
        mouseMoves: 0,
        pages: 0,
      },
    });
  });
});

describe("formatting and access", () => {
  it("formats offsets", () => {
    expect(formatOffset(0)).toBe("0:00");
    expect(formatOffset(65_000)).toBe("1:05");
    expect(formatOffset(3_725_000)).toBe("1:02:05");
    expect(formatOffset(-5)).toBe("0:00");
  });

  it("shows just the path of a recorded URL", () => {
    expect(displayPath("https://a.test/x/y?z=1#h")).toBe("/x/y?z=1");
    expect(displayPath("/relative")).toBe("/relative");
  });

  it("keeps recordings to the research team", () => {
    expect(canViewSessionRecordings("ADMIN")).toBe(true);
    expect(canViewSessionRecordings("RESEARCHER")).toBe(true);
    expect(canViewSessionRecordings("TEACHER")).toBe(false);
    expect(canViewSessionRecordings("STUDENT")).toBe(false);
  });
});

describe("replay areas", () => {
  it.each([
    ["/student/classes/c/quiz/q", "quiz"],
    ["https://site.test/student/classes/c/quiz/q/practice?x=1#h", "quiz"],
    ["/student/classes/c/quiz/q/other", null],
    ["/student/classes/c", null],
    ["/student/simulations", "simulation"],
    ["/student/simulations/a?x=1", "simulation"],
    ["/student/simulations-other", null],
    ["/student/materials/m#read", "material"],
    ["/student/materials", "material"],
    ["/student/results/q", null],
  ])("maps %s to %s", (path, area) => {
    expect(areaForPath(path)).toBe(area);
  });

  const overlay = (offset: number, area: string, state: string) =>
    custom(offset, "area", { area, state });

  it("restores nested overlays and the current underlying page", () => {
    const events = [
      ev(0, 4, { href: "/student/classes/c/quiz/q" }),
      overlay(10, "simulation", "enter"),
      overlay(20, "material", "enter"),
      custom(30, "navigate", { path: "/student" }),
      overlay(40, "material", "leave"),
      overlay(50, "simulation", "leave"),
      ev(60, 3),
    ];
    expect(buildAreaSegments(events)).toEqual([
      { area: "quiz", startMs: 0, endMs: 10 },
      { area: "simulation", startMs: 10, endMs: 20 },
      { area: "material", startMs: 20, endMs: 40 },
      { area: "simulation", startMs: 40, endMs: 50 },
    ]);
    expect(areasInEvents(events)).toEqual(["quiz", "simulation", "material"]);
  });

  it("handles unbalanced leaves, re-enters, and same-area adjacency", () => {
    const events = [
      ev(0, 2),
      overlay(5, "material", "leave"),
      overlay(10, "simulation", "enter"),
      overlay(20, "material", "enter"),
      overlay(30, "simulation", "enter"),
      overlay(40, "material", "leave"),
      overlay(50, "simulation", "leave"),
      ev(60, 3),
    ];
    expect(buildAreaSegments(events, "/student/simulations")).toEqual([
      { area: "simulation", startMs: 0, endMs: 20 },
      { area: "material", startMs: 20, endMs: 30 },
      { area: "simulation", startMs: 30, endMs: 60 },
    ]);
  });

  it("seeds increment-only batches and includes instantaneous touches", () => {
    expect(
      buildAreaSegments([ev(0, 3), ev(10, 3)], "/student/materials"),
    ).toEqual([{ area: "material", startMs: 0, endMs: 10 }]);
    expect(areasInEvents([ev(0, 3)])).toEqual([]);
    expect(areasInEvents([overlay(0, "quiz", "enter")])).toEqual(["quiz"]);
    expect(buildAreaSegments([])).toEqual([]);
  });

  it("ignores malformed events and sorts without mutating input", () => {
    const events = [
      null,
      ev(0, 2),
      ev(30, 3),
      overlay(10, "material", "enter"),
      overlay(20, "invalid", "enter"),
      overlay(22, "material", "oops"),
      { type: 4, timestamp: NaN, data: { href: "/student/simulations" } },
      custom(25, "navigate", { path: 7 }),
    ] as unknown as ReplayEvent[];
    expect(buildAreaSegments(events)).toEqual([
      { area: "material", startMs: 10, endMs: 30 },
    ]);
    expect(areasInEvents(events)).toEqual(["material"]);
    expect(events[2].timestamp).toBe(T0 + 30);
    expect(isReplayArea("quiz")).toBe(true);
    expect(isReplayArea(null)).toBe(false);
  });

  it("annotates timeline entries with the effective overlay area", () => {
    const { entries } = buildTimeline([
      ev(0, 4, { href: "/student/materials" }),
      overlay(5, "simulation", "enter"),
      custom(10, "click", {}),
      overlay(15, "simulation", "leave"),
      custom(20, "click", {}),
    ]);
    expect(entries.map((entry) => entry.area)).toEqual([
      "material",
      "simulation",
      "material",
    ]);
  });

  it("processes 100k events within a generous performance ceiling", () => {
    const events = Array.from({ length: 100_000 }, (_, i) => ev(i, 3));
    const started = performance.now();
    expect(buildAreaSegments(events, "/student/materials")).toEqual([
      { area: "material", startMs: 0, endMs: 99_999 },
    ]);
    expect(areasInEvents(events, "/student/materials")).toEqual(["material"]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
