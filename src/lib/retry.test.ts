import { describe, it, expect, vi, afterEach } from "vitest";
import { retryWithExponentialBackoff } from "./retry";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("retryWithExponentialBackoff", () => {
  it("returns the result on the first try without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retryWithExponentialBackoff(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and resolves once the call succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValue("ok");

    const p = retryWithExponentialBackoff(fn, 5, 10, 100);
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting maxRetries attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    const p = retryWithExponentialBackoff(fn, 3, 10, 100);
    p.catch(() => {}); // avoid an unhandled rejection while timers advance
    await vi.runAllTimersAsync();

    await expect(p).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("logs a warning between attempts", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue("ok");

    const p = retryWithExponentialBackoff(fn, 3, 10, 100);
    await vi.runAllTimersAsync();
    await p;

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("boom");
  });

  it("caps the backoff delay at maxDelayMs", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockResolvedValue("ok");

    // baseDelay 1000, attempt 1 => 2000, attempt 2 => 4000 but capped at 3000.
    const p = retryWithExponentialBackoff(fn, 5, 1000, 3000);
    await vi.runAllTimersAsync();
    await p;

    const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
    expect(delays).toEqual([2000, 3000]);
  });
});
