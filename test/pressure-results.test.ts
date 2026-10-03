import { describe, expect, it } from "vitest";
import {
  crossedThresholds,
  resolveDurationMs,
  summarizeChecks,
} from "../pressure/lib/results.mjs";

describe("pressure result check summary", () => {
  it("derives a bounded error rate from recorded checks", () => {
    expect(
      summarizeChecks([
        { outcome: "PASS" },
        { outcome: "FAIL" },
        { outcome: "FAIL" },
      ]),
    ).toEqual({
      totalChecks: 3,
      passedChecks: 1,
      failedChecks: 2,
      errorRate: 2 / 3,
    });
  });

  it("does not count diagnostic failure entries outside the check list", () => {
    const checks = [{ outcome: "FAIL" }];
    const failures = [...checks, { name: "suite", detail: "request failed" }];

    expect(failures).toHaveLength(2);
    expect(summarizeChecks(checks)).toEqual({
      totalChecks: 1,
      passedChecks: 0,
      failedChecks: 1,
      errorRate: 1,
    });
  });
});

describe("k6 threshold interpretation", () => {
  // The two summary shapes mean OPPOSITE things. Reading the boolean form
  // backwards shipped once: it marked every passing threshold as a failure,
  // dropped every genuine breach from the list, published every run as FAIL,
  // and made the runner exit non-zero on a passing run. These are the exact
  // values observed on a real clone.
  it("treats --summary-export true as CROSSED and false as held", () => {
    expect(
      crossedThresholds({
        "step_duration{step:student_dashboard}": {
          thresholds: { "p(99)<1500": true, "p(95)<600": false },
        },
        "step_duration{step:admin_resources}": {
          thresholds: { "p(95)<800": false, "p(99)<2000": false },
        },
        sqlite_busy: { thresholds: { "count==0": false } },
      }),
    ).toEqual(["step_duration{step:student_dashboard} p(99)<1500"]);
  });

  it("treats handleSummary ok:false as CROSSED and ok:true as held", () => {
    expect(
      crossedThresholds({
        a: { thresholds: { "p(95)<100": { ok: false } } },
        b: { thresholds: { "p(95)<100": { ok: true } } },
      }),
    ).toEqual(["a p(95)<100"]);
  });

  it("reports nothing when every threshold held", () => {
    expect(
      crossedThresholds({
        sqlite_busy: { thresholds: { "count==0": false } },
        unexpected_errors: { thresholds: { "count==0": false } },
      }),
    ).toEqual([]);
  });

  it("tolerates metrics with no thresholds at all", () => {
    expect(crossedThresholds({ http_reqs: { count: 10 } })).toEqual([]);
    expect(crossedThresholds({})).toEqual([]);
    expect(crossedThresholds(undefined)).toEqual([]);
  });
});

describe("run duration", () => {
  // k6's --summary-export has no `state` key at all, so reading
  // summary.state.testRunDurationMs published durationMs 0 for every run and
  // the dashboard's Duration column was empty throughout.
  it("falls back to the meta wall clock when the summary has no state", () => {
    expect(
      resolveDurationMs(
        { metrics: {} } as never,
        { startedAt: "2026-09-16T20:07:13Z", finishedAt: "2026-09-16T20:07:14Z" },
      ),
    ).toBe(1000);
  });

  it("prefers the summary value when handleSummary provided one", () => {
    expect(
      resolveDurationMs({ state: { testRunDurationMs: 4242 } }, {
        startedAt: "2026-09-16T20:07:13Z",
        finishedAt: "2026-09-16T20:07:14Z",
      }),
    ).toBe(4242);
  });

  it("never returns a negative duration from mis-ordered timestamps", () => {
    expect(
      resolveDurationMs(undefined, {
        startedAt: "2026-09-16T20:07:14Z",
        finishedAt: "2026-09-16T20:07:13Z",
      }),
    ).toBe(0);
  });

  it("returns 0 when neither source has usable timestamps", () => {
    expect(resolveDurationMs(undefined, undefined)).toBe(0);
    expect(resolveDurationMs({}, { startedAt: "not-a-date" })).toBe(0);
  });
});
