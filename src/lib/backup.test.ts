import { describe, it, expect } from "vitest";
import { computeNextRun, isBackupDue, retentionFromRow } from "./backup";
import type { BackupConfig } from "@prisma/client";

function nyTime(d: Date): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(d)) map[p.type] = p.value;
  return `${map.hour}:${map.minute}`;
}

describe("computeNextRun", () => {
  const row = { intervalHours: 24, anchorTime: "02:00", timezone: "America/New_York" };

  it("returns the next 02:00 America/New_York strictly after `from`", () => {
    const from = new Date("2026-06-17T10:00:00Z"); // 06:00 EDT
    const next = computeNextRun(row, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(nyTime(next)).toBe("02:00");
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it("skips to the next day when already past today's anchor", () => {
    const from = new Date("2026-06-17T07:00:00Z"); // 03:00 EDT, just past anchor
    const next = computeNextRun(row, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(nyTime(next)).toBe("02:00");
  });

  it("honors sub-daily intervals on the hour", () => {
    const next = computeNextRun(
      { intervalHours: 6, anchorTime: "02:00", timezone: "America/New_York" },
      new Date("2026-06-17T10:00:00Z"),
    );
    expect(next.getTime()).toBeGreaterThan(new Date("2026-06-17T10:00:00Z").getTime());
    expect(nyTime(next).endsWith(":00")).toBe(true);
  });
});

describe("isBackupDue", () => {
  const enabled = { enabled: true } as BackupConfig;

  it("is false when null or disabled", () => {
    expect(isBackupDue(null)).toBe(false);
    expect(isBackupDue({ enabled: false } as BackupConfig)).toBe(false);
  });

  it("is true when enabled with no nextRunAt", () => {
    expect(isBackupDue({ ...enabled, nextRunAt: null } as BackupConfig)).toBe(true);
  });

  it("compares nextRunAt against now", () => {
    const now = new Date("2026-06-17T12:00:00Z");
    expect(
      isBackupDue({ ...enabled, nextRunAt: new Date("2026-06-17T11:00:00Z") } as BackupConfig, now),
    ).toBe(true);
    expect(
      isBackupDue({ ...enabled, nextRunAt: new Date("2026-06-17T13:00:00Z") } as BackupConfig, now),
    ).toBe(false);
  });
});

describe("retentionFromRow", () => {
  it("returns defaults for null", () => {
    expect(retentionFromRow(null)).toEqual({
      keepRecent: 7,
      keepWeekly: 4,
      keepMonthly: 12,
      keepYearly: 3,
    });
  });

  it("reads tier fields from a row", () => {
    const row = { keepRecent: 1, keepWeekly: 2, keepMonthly: 3, keepYearly: 4 } as BackupConfig;
    expect(retentionFromRow(row)).toEqual({
      keepRecent: 1,
      keepWeekly: 2,
      keepMonthly: 3,
      keepYearly: 4,
    });
  });
});
