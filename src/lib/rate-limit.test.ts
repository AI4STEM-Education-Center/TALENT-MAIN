import { describe, it, expect } from "vitest";
import { checkRateLimit, clientIp } from "./rate-limit";

describe("checkRateLimit", () => {
  it("allows up to the limit then blocks within the window", () => {
    const key = "test-allow-then-block";
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(key, 3, 60_000, t0).allowed).toBe(true);
    }
    const blocked = checkRateLimit(key, 3, 60_000, t0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets once the window elapses", () => {
    const key = "test-window-reset";
    const t0 = 2_000_000;
    expect(checkRateLimit(key, 1, 1_000, t0).allowed).toBe(true);
    expect(checkRateLimit(key, 1, 1_000, t0).allowed).toBe(false);
    // After the window, the bucket resets.
    expect(checkRateLimit(key, 1, 1_000, t0 + 1_001).allowed).toBe(true);
  });

  it("tracks distinct keys independently", () => {
    const t0 = 3_000_000;
    expect(checkRateLimit("key-a", 1, 60_000, t0).allowed).toBe(true);
    expect(checkRateLimit("key-b", 1, 60_000, t0).allowed).toBe(true);
    expect(checkRateLimit("key-a", 1, 60_000, t0).allowed).toBe(false);
  });
});

describe("clientIp", () => {
  it("uses the first x-forwarded-for hop", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to a sentinel when no proxy header is present", () => {
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});
