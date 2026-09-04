import { describe, expect, it } from "vitest";
import { summarizeChecks } from "../pressure/lib/results.mjs";

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
