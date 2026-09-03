import { describe, it, expect } from "vitest";
import {
  normalizeConsentExportFilter,
  buildConsentRecordWhere,
} from "@/lib/consent-export";

describe("normalizeConsentExportFilter", () => {
  it("defaults to an empty (match-everything) filter", () => {
    expect(normalizeConsentExportFilter({})).toEqual({});
    expect(normalizeConsentExportFilter(null)).toEqual({});
  });

  it("accepts a valid explicit-ids filter", () => {
    expect(normalizeConsentExportFilter({ recordIds: ["a", "b"] })).toEqual({
      recordIds: ["a", "b"],
    });
  });

  it("rejects an invalid role/decision", () => {
    expect(normalizeConsentExportFilter({ role: "ADMIN" })).toBeNull();
    expect(normalizeConsentExportFilter({ decision: "MAYBE" })).toBeNull();
  });

  it("rejects an unparseable date", () => {
    expect(normalizeConsentExportFilter({ fromDate: "not-a-date" })).toBeNull();
  });

  it("rejects a non-array recordIds", () => {
    expect(
      normalizeConsentExportFilter({ recordIds: "not-an-array" }),
    ).toBeNull();
  });
});

describe("buildConsentRecordWhere", () => {
  it("builds an id-in clause for explicit record ids", () => {
    expect(buildConsentRecordWhere({ recordIds: ["a", "b"] })).toEqual({
      id: { in: ["a", "b"] },
    });
  });

  it("combines role/decision/date-range filters", () => {
    expect(
      buildConsentRecordWhere({
        role: "STUDENT",
        decision: "AGREE",
        fromDate: "2026-01-01",
      }),
    ).toEqual({
      role: "STUDENT",
      decision: "AGREE",
      signedAt: { gte: new Date("2026-01-01") },
    });
  });

  it("returns an empty where for an empty filter (matches everything)", () => {
    expect(buildConsentRecordWhere({})).toEqual({});
  });
});
