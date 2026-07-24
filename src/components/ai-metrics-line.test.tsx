import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiMetricsLine } from "./ai-metrics-line";

describe("AiMetricsLine", () => {
  it("renders the persisted extraction stats shown on teacher and admin material lists", () => {
    const html = renderToStaticMarkup(
      <AiMetricsLine
        metrics={{
          model: "openai/gpt-5.5",
          ttftMs: 43_787,
          totalMs: 89_252,
          tokens: 2_776,
        }}
      />
    );

    expect(html).toContain(
      "Extracted by openai/gpt-5.5 · TTFT 43.787s · gen 45.465s · total 89.252s · 2776 tokens · 61.1 tok/s"
    );
  });

  it("renders nothing when no metrics have been persisted", () => {
    expect(renderToStaticMarkup(<AiMetricsLine metrics={{}} />)).toBe("");
  });
});
