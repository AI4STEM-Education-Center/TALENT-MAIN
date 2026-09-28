import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQuizVariantRequestGate } from "./quiz-variant-requests";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("serializes requests and spaces starts across generation and validation", async () => {
  const request = createQuizVariantRequestGate();
  let finish!: () => void;
  const first = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const second = vi.fn(async () => "checked");
  const a = request(first);
  const b = request(second);
  await vi.advanceTimersByTimeAsync(1000);
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  finish();
  await a;
  await vi.advanceTimersByTimeAsync(999);
  expect(second).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await b).toBe("checked");
});

it.each([
  ["retry-after", "10", 10_000],
  ["retry-after-ms", "9000", 9000],
  ["retry-after", "Thu, 01 Jan 2026 00:00:12 GMT", 12_000],
])(
  "honors %s %s before recovering from overload",
  async (header, value, delay) => {
    const request = createQuizVariantRequestGate();
    const call = vi
      .fn()
      .mockRejectedValueOnce({
        status: 429,
        headers: new Headers({ [header]: value }),
      })
      .mockResolvedValue("ok");
    const result = request(call);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(call).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("ok");
  },
);

it("bounds transient retries with exponential backoff and keeps the queue usable", async () => {
  const request = createQuizVariantRequestGate();
  const error = Object.assign(new Error("Unavailable"), { status: 503 });
  const times: number[] = [];
  const start = Date.now();
  const call = vi.fn(async () => {
    times.push(Date.now() - start);
    throw error;
  });
  const result = expect(request(call)).rejects.toBe(error);
  await vi.runAllTimersAsync();
  await result;
  expect(times).toEqual([0, 2000, 6000, 14000]);
  const next = vi.fn(async () => "ok");
  const recovered = request(next);
  await vi.advanceTimersByTimeAsync(15_999);
  expect(next).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await recovered).toBe("ok");
});

it.each([new Error("Invalid answer key"), { status: 401 }, { status: 400 }])(
  "does not retry permanent errors",
  async (error) => {
    const request = createQuizVariantRequestGate();
    const call = vi.fn().mockRejectedValue(error);
    await expect(request(call)).rejects.toBe(error);
    expect(call).toHaveBeenCalledOnce();
  },
);

it.each(["APIConnectionError", "APIConnectionTimeoutError"])(
  "recovers from %s",
  async (name) => {
    const request = createQuizVariantRequestGate();
    const call = vi
      .fn()
      .mockRejectedValueOnce({ name })
      .mockResolvedValue("ok");
    const result = request(call);
    await vi.runAllTimersAsync();
    expect(await result).toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
  },
);
