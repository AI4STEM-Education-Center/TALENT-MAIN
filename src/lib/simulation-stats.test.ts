import { describe, it, expect } from "vitest";
import {
  BOUNCE_ACTIVE_MS,
  ENGAGED_ACTIVE_MS,
  formatDurationMs,
  summarizeSimulationEngagement,
  retakeImprovementBySimUse,
  type SimSessionRecord,
  type AttemptRecord,
} from "./simulation-stats";

const session = (over: Partial<SimSessionRecord>): SimSessionRecord => ({
  simulationId: "sim-1",
  studentId: "s1",
  quizId: "q1",
  startedAt: new Date("2026-07-01T10:00:00Z"),
  activeMs: 60_000,
  interactionCount: 12,
  paramChanges: 5,
  ...over,
});

const attempt = (over: Partial<AttemptRecord>): AttemptRecord => ({
  studentId: "s1",
  quizId: "q1",
  score: 50,
  completedAt: new Date("2026-07-01T09:00:00Z"),
  ...over,
});

describe("formatDurationMs", () => {
  it("formats seconds, minutes, and hours compactly", () => {
    expect(formatDurationMs(0)).toBe("0s");
    expect(formatDurationMs(32_000)).toBe("32s");
    expect(formatDurationMs(245_000)).toBe("4m 05s");
    expect(formatDurationMs(3_900_000)).toBe("1h 05m");
    expect(formatDurationMs(-100)).toBe("0s");
  });
});

describe("summarizeSimulationEngagement", () => {
  it("folds sessions into per-simulation rows sorted by unique students", () => {
    const rows = summarizeSimulationEngagement(
      [
        session({ simulationId: "a", studentId: "s1", activeMs: 40_000 }),
        session({ simulationId: "a", studentId: "s2", activeMs: 80_000 }),
        session({ simulationId: "a", studentId: "s2", activeMs: 60_000 }),
        session({ simulationId: "b", studentId: "s1" }),
      ],
      new Map([
        ["a", "Friction Explorer"],
        ["b", "Projectile Lab"],
      ]),
    );
    expect(rows.map((r) => r.simulationId)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({
      title: "Friction Explorer",
      sessions: 3,
      uniqueStudents: 2,
      medianActiveMs: 60_000,
      bounceRate: 0,
    });
  });

  it("counts short or interaction-free sessions as bounces", () => {
    const [row] = summarizeSimulationEngagement(
      [
        session({ activeMs: BOUNCE_ACTIVE_MS - 1 }),
        session({ interactionCount: 0 }),
        session({}),
        session({}),
      ],
      new Map(),
    );
    expect(row.title).toBe("Removed simulation");
    expect(row.bounceRate).toBe(0.5);
  });

  it("returns an empty list for no sessions", () => {
    expect(summarizeSimulationEngagement([], new Map())).toEqual([]);
  });
});

describe("retakeImprovementBySimUse", () => {
  const first = attempt({
    score: 40,
    completedAt: new Date("2026-07-01T09:00:00Z"),
  });
  const retake = attempt({
    score: 70,
    completedAt: new Date("2026-07-02T09:00:00Z"),
  });

  it("splits retakers by engaged simulation use after the first attempt", () => {
    const impact = retakeImprovementBySimUse(
      [
        first,
        retake, // s1 used a sim between attempts → +30 with
        attempt({ studentId: "s2", score: 50 }),
        attempt({
          studentId: "s2",
          score: 60,
          completedAt: new Date("2026-07-02T09:00:00Z"),
        }), // no sim → +10 without
      ],
      [
        session({
          studentId: "s1",
          startedAt: new Date("2026-07-01T10:00:00Z"),
        }),
      ],
    );
    expect(impact.withSim).toEqual({ students: 1, meanDelta: 30 });
    expect(impact.withoutSim).toEqual({ students: 1, meanDelta: 10 });
  });

  it("ignores sessions before the first attempt, below the engagement bar, or on other quizzes", () => {
    const cases: SimSessionRecord[] = [
      session({ startedAt: new Date("2026-07-01T08:00:00Z") }), // before first attempt
      session({ activeMs: ENGAGED_ACTIVE_MS - 1 }), // not engaged
      session({ quizId: "other-quiz" }),
      session({ quizId: null }),
      session({ studentId: "someone-else" }),
    ];
    const impact = retakeImprovementBySimUse([first, retake], cases);
    expect(impact.withSim.students).toBe(0);
    expect(impact.withoutSim).toEqual({ students: 1, meanDelta: 30 });
  });

  it("uses the best later score and skips single-attempt students", () => {
    const impact = retakeImprovementBySimUse(
      [
        first,
        attempt({ score: 55, completedAt: new Date("2026-07-02T09:00:00Z") }),
        attempt({ score: 90, completedAt: new Date("2026-07-03T09:00:00Z") }),
        attempt({ studentId: "s9", score: 100 }), // one attempt only — excluded
      ],
      [],
    );
    expect(impact.withoutSim).toEqual({ students: 1, meanDelta: 50 });
    expect(impact.withSim.students).toBe(0);
  });
});
