import { describe, it, expect } from "vitest";
import { formatMs, formatAiMetrics } from "./ai-metrics";

describe("formatMs", () => {
  it("keeps whole milliseconds at or below one second", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(240)).toBe("240ms");
    expect(formatMs(1000)).toBe("1000ms"); // exactly 1s is not "larger than 1 second"
  });

  it("switches to seconds with three decimals once past one second", () => {
    expect(formatMs(1001)).toBe("1.001s");
    expect(formatMs(19438)).toBe("19.438s");
    expect(formatMs(25123)).toBe("25.123s");
  });

  it("rounds sub-second fractional inputs", () => {
    expect(formatMs(240.6)).toBe("241ms");
  });
});

describe("formatAiMetrics", () => {
  it("returns an empty string when nothing is available", () => {
    expect(formatAiMetrics({})).toBe("");
  });

  it("derives generation time and token rate from total minus TTFT", () => {
    // TTFT 19.438s, total 25.123s -> gen 5.685s; 3077 / 5.685 ≈ 541.2 tok/s
    expect(
      formatAiMetrics({ model: "openai/gpt-5.5", ttftMs: 19438, totalMs: 25123, tokens: 3077 })
    ).toBe("openai/gpt-5.5 · TTFT 19.438s · gen 5.685s · total 25.123s · 3077 tokens · 541.2 tok/s");
  });

  it("omits gen/total/rate when total time is missing (legacy rows)", () => {
    expect(formatAiMetrics({ model: "m", ttftMs: 240, tokens: 512 })).toBe(
      "m · TTFT 240ms · 512 tokens"
    );
  });

  it("names the provider and service tier separately from the model", () => {
    expect(
      formatAiMetrics({
        model: "openai/gpt-5.5",
        provider: "cloudflare",
        serviceTier: "flex",
        ttftMs: 19438,
        totalMs: 25123,
        tokens: 3077,
      })
    ).toBe(
      "openai/gpt-5.5 · via cloudflare · tier flex · TTFT 19.438s · gen 5.685s · total 25.123s · 3077 tokens · 541.2 tok/s"
    );
  });

  it("leaves rows written before provider/tier were stored exactly as they were", () => {
    expect(
      formatAiMetrics({ model: "cloudflare/openai/gpt-5.5", ttftMs: 19438, totalMs: 25123, tokens: 3077 })
    ).toBe(
      "cloudflare/openai/gpt-5.5 · TTFT 19.438s · gen 5.685s · total 25.123s · 3077 tokens · 541.2 tok/s"
    );
  });

  it("drops a derived gen window the response was too buffered to have earned", () => {
    // A gateway that flushed 222 tokens 32ms after the first delta: the tokens
    // were produced during the 6.805s we recorded as TTFT, so report the rate
    // over the whole call (32.5 tok/s) rather than 6937 tok/s over the flush.
    expect(
      formatAiMetrics({
        model: "openai/gpt-5.5",
        provider: "cloudflare",
        ttftMs: 6805,
        totalMs: 6837,
        tokens: 222,
      })
    ).toBe(
      "openai/gpt-5.5 · via cloudflare · TTFT 6.805s · total 6.837s · 222 tokens · 32.5 tok/s"
    );
  });

  it("drops an explicitly stored generation window that is a flush artifact", () => {
    // Same guard for the multi-call aggregate persisted on older rows.
    expect(
      formatAiMetrics({
        model: "openai/gpt-5.5",
        ttftMs: 5779,
        generationMs: 92,
        totalMs: 40547,
        tokens: 2283,
      })
    ).toBe("openai/gpt-5.5 · TTFT 5.779s · total 40.547s · 2283 tokens · 56.3 tok/s");
  });

  it("marks estimated token counts with a ~ suffix", () => {
    expect(formatAiMetrics({ tokens: 512, tokensEstimated: true })).toBe("512~ tokens");
  });

  it("uses an explicit generation window for aggregated multi-call work", () => {
    expect(
      formatAiMetrics({
        model: "openai/gpt-5.5",
        ttftMs: 200,
        generationMs: 500,
        totalMs: 900,
        tokens: 50,
      })
    ).toBe(
      "openai/gpt-5.5 · TTFT 200ms · gen 500ms · total 900ms · 50 tokens · 100.0 tok/s"
    );
  });
});
