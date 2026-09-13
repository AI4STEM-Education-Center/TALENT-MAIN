import { describe, expect, it } from "vitest";
import { assessCapacity } from "../pressure/recommend-size.mjs";

function result(
  instanceType: string,
  students: number,
  status: "PASS" | "FAIL",
  vcpus: number,
) {
  return {
    runId: `${instanceType}-${students}`,
    suite: "pressure",
    scenario: "exam-day",
    status,
    finishedAt: "2026-09-04T12:00:00Z",
    virtualUsers: students,
    latency: { p95Ms: 800 },
    metadata: {
      sutType: instanceType,
      sutVcpus: vcpus,
      sutMemoryMiB: vcpus * 2048,
      studentTarget: students,
    },
  };
}

describe("EC2 size recommendation", () => {
  it("selects the smallest measured type proven at the requested student count", () => {
    const assessment = assessCapacity(
      [
        result("t3a.large", 300, "FAIL", 2),
        result("m7i.xlarge", 500, "PASS", 4),
        result("m7i.2xlarge", 800, "PASS", 8),
      ],
      500,
    );

    expect(assessment.recommendation?.instanceType).toBe("m7i.xlarge");
    expect(assessment.types[0].lowestFail?.students).toBe(300);
  });

  it("does not extrapolate beyond the highest passing measurement", () => {
    const assessment = assessCapacity(
      [result("m7i.xlarge", 300, "PASS", 4)],
      500,
    );
    expect(assessment.recommendation).toBeNull();
  });
});
