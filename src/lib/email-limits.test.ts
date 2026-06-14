import { describe, it, expect } from "vitest";
import {
  parseChannels,
  serializeChannels,
  evaluateQuota,
  startOfDay,
  startOfMonth,
  DEFAULT_EMAIL_DAILY_LIMIT,
  DEFAULT_EMAIL_MONTHLY_LIMIT,
} from "./email-limits";

describe("parseChannels", () => {
  it("parses the stored comma-joined string", () => {
    expect(parseChannels("IN_APP,EMAIL")).toEqual({ inApp: true, email: true });
    expect(parseChannels("EMAIL")).toEqual({ inApp: false, email: true });
    expect(parseChannels("IN_APP")).toEqual({ inApp: true, email: false });
    expect(parseChannels(" in_app , email ")).toEqual({ inApp: true, email: true });
  });
  it("parses a { inApp, email } object", () => {
    expect(parseChannels({ inApp: true, email: false })).toEqual({ inApp: true, email: false });
    expect(parseChannels({ inApp: "yes", email: 1 })).toEqual({ inApp: false, email: false });
  });
  it("returns no channels for empty/invalid input", () => {
    expect(parseChannels("")).toEqual({ inApp: false, email: false });
    expect(parseChannels(null)).toEqual({ inApp: false, email: false });
    expect(parseChannels(undefined)).toEqual({ inApp: false, email: false });
  });
});

describe("serializeChannels", () => {
  it("round-trips with parseChannels", () => {
    expect(serializeChannels({ inApp: true, email: true })).toBe("IN_APP,EMAIL");
    expect(serializeChannels({ inApp: false, email: true })).toBe("EMAIL");
    expect(serializeChannels({ inApp: true, email: false })).toBe("IN_APP");
    expect(serializeChannels({ inApp: false, email: false })).toBe("");
  });
});

describe("evaluateQuota", () => {
  const base = {
    dailyLimit: DEFAULT_EMAIL_DAILY_LIMIT,
    monthlyLimit: DEFAULT_EMAIL_MONTHLY_LIMIT,
  };

  it("subtracts used from both windows and takes the smaller remaining", () => {
    const q = evaluateQuota({ ...base, dailyUsed: 90, monthlyUsed: 100 });
    expect(q.dailyRemaining).toBe(10);
    expect(q.monthlyRemaining).toBe(2900);
    expect(q.remaining).toBe(10); // daily is the binding cap
  });

  it("monthly can be the binding cap", () => {
    const q = evaluateQuota({ ...base, dailyUsed: 0, monthlyUsed: 2995 });
    expect(q.remaining).toBe(5);
  });

  it("never reports negative remaining when over-used", () => {
    const q = evaluateQuota({ ...base, dailyUsed: 150, monthlyUsed: 4000 });
    expect(q.dailyRemaining).toBe(0);
    expect(q.monthlyRemaining).toBe(0);
    expect(q.remaining).toBe(0);
  });

  it("allows a request that fits within remaining", () => {
    expect(evaluateQuota({ ...base, dailyUsed: 90, monthlyUsed: 0, requested: 10 }).allowed).toBe(true);
    expect(evaluateQuota({ ...base, dailyUsed: 90, monthlyUsed: 0, requested: 11 }).allowed).toBe(false);
  });

  it("treats a missing request as 0 (always allowed)", () => {
    expect(evaluateQuota({ ...base, dailyUsed: 100, monthlyUsed: 3000 }).allowed).toBe(true);
  });

  it("respects per-teacher override limits", () => {
    const q = evaluateQuota({ dailyLimit: 5, monthlyLimit: 20, dailyUsed: 4, monthlyUsed: 4, requested: 2 });
    expect(q.remaining).toBe(1);
    expect(q.allowed).toBe(false);
  });
});

describe("startOfDay / startOfMonth", () => {
  it("zeroes the time to midnight for the day boundary", () => {
    const d = startOfDay(new Date(2026, 5, 13, 16, 45, 30));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(13);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
  it("returns the first of the month for the month boundary", () => {
    const d = startOfMonth(new Date(2026, 5, 13, 16, 45, 30));
    expect(d.getDate()).toBe(1);
    expect(d.getMonth()).toBe(5);
    expect(d.getHours()).toBe(0);
  });
});
