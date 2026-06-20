import { describe, it, expect } from "vitest";
import {
  selectForRetention,
  backupKeyName,
  parseBackupTimestamp,
  resolveAppEnv,
  type RetentionPolicy,
} from "./backup-core";

const utc = (y: number, m: number, d: number, h = 0): Date =>
  new Date(Date.UTC(y, m - 1, d, h));

describe("backup key naming", () => {
  it("round-trips a UTC timestamp through name and parse", () => {
    const d = utc(2026, 6, 17, 2);
    const name = backupKeyName(d);
    expect(name).toBe("backup-20260617T020000Z.db.gz");
    expect(parseBackupTimestamp(name)?.getTime()).toBe(d.getTime());
  });

  it("rejects non-backup names", () => {
    expect(parseBackupTimestamp("notes.txt")).toBeNull();
    expect(parseBackupTimestamp("backup-bad.db.gz")).toBeNull();
  });
});

describe("selectForRetention (GFS)", () => {
  const policy: RetentionPolicy = { keepRecent: 2, keepWeekly: 2, keepMonthly: 2, keepYearly: 2 };

  // key === the date label so assertions are readable.
  const items = [
    { key: "2026-06-17", date: utc(2026, 6, 17) }, // recent + newest of week/month/year
    { key: "2026-06-16", date: utc(2026, 6, 16) }, // recent (same week as 17)
    { key: "2026-06-15", date: utc(2026, 6, 15) }, // same ISO week as 16/17 → dropped
    { key: "2026-06-08", date: utc(2026, 6, 8) }, //  newest of previous week → weekly keep
    { key: "2026-05-20", date: utc(2026, 5, 20) }, // newest of May → monthly keep
    { key: "2026-04-10", date: utc(2026, 4, 10) }, // older month → dropped
    { key: "2025-12-31", date: utc(2025, 12, 31) }, // newest of 2025 → yearly keep
    { key: "2024-11-11", date: utc(2024, 11, 11) }, // older year → dropped
    { key: "2023-01-01", date: utc(2023, 1, 1) }, //  older year → dropped
  ];

  it("keeps recent + one per recent week/month/year and prunes the rest", () => {
    const keep = selectForRetention(items, policy);
    expect([...keep].sort()).toEqual(
      ["2025-12-31", "2026-05-20", "2026-06-08", "2026-06-16", "2026-06-17"].sort(),
    );
    for (const dropped of ["2026-06-15", "2026-04-10", "2024-11-11", "2023-01-01"]) {
      expect(keep.has(dropped)).toBe(false);
    }
  });

  it("keeps everything when limits exceed the number of backups", () => {
    const keep = selectForRetention(items, {
      keepRecent: 100,
      keepWeekly: 0,
      keepMonthly: 0,
      keepYearly: 0,
    });
    expect(keep.size).toBe(items.length);
  });

  it("keeps nothing when all tiers are zero", () => {
    const keep = selectForRetention(items, {
      keepRecent: 0,
      keepWeekly: 0,
      keepMonthly: 0,
      keepYearly: 0,
    });
    expect(keep.size).toBe(0);
  });
});

describe("resolveAppEnv", () => {
  it("recognizes prod and defaults everything else to dev", () => {
    const prev = process.env.APP_ENV;
    try {
      process.env.APP_ENV = "prod";
      expect(resolveAppEnv()).toBe("prod");
      process.env.APP_ENV = "dev";
      expect(resolveAppEnv()).toBe("dev");
      delete process.env.APP_ENV;
      expect(resolveAppEnv()).toBe("dev");
      process.env.APP_ENV = "anything-else";
      expect(resolveAppEnv()).toBe("dev");
    } finally {
      if (prev === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = prev;
    }
  });
});
