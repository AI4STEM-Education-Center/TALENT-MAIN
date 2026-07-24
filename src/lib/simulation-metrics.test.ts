import { describe, expect, it } from "vitest";
import {
  buildSimulationMetrics,
  simulationMetricsView,
} from "./simulation-metrics";
import type { AiCallMetrics } from "./ai-streaming";

const call = (
  overrides: Partial<AiCallMetrics> = {}
): AiCallMetrics => ({
  model: "gpt-5.5",
  ttftMs: 200,
  completionTokens: 20,
  tokensEstimated: false,
  totalMs: 500,
  tokensPerSec: 20 / 0.3,
  ...overrides,
});

describe("buildSimulationMetrics", () => {
  it("persists provider-qualified, accurate multi-call metrics", () => {
    expect(
      buildSimulationMetrics("openai", [
        call(),
        call({
          ttftMs: 100,
          totalMs: 300,
          completionTokens: 30,
          tokensEstimated: true,
        }),
      ])
    ).toEqual({
      aiModel: "openai/gpt-5.5",
      aiTtftMs: 150,
      aiGenerationMs: 500,
      aiTotalMs: 800,
      aiTokens: 50,
      aiTokensEstimated: true,
    });
  });

  it("does not duplicate an existing provider prefix", () => {
    expect(
      buildSimulationMetrics("openai", [
        call({ model: "openai/gpt-5.5" }),
      ]).aiModel
    ).toBe("openai/gpt-5.5");
  });

  it("returns nullable fields when a job made no model calls", () => {
    expect(buildSimulationMetrics("local", [])).toEqual({
      aiModel: null,
      aiTtftMs: null,
      aiGenerationMs: null,
      aiTotalMs: null,
      aiTokens: null,
      aiTokensEstimated: null,
    });
  });
});

describe("simulationMetricsView", () => {
  it("maps persisted simulation fields to display fields", () => {
    expect(
      simulationMetricsView({
        aiModel: "openai/gpt-5.5",
        aiTtftMs: 150,
        aiGenerationMs: 500,
        aiTotalMs: 800,
        aiTokens: 50,
        aiTokensEstimated: false,
      })
    ).toEqual({
      model: "openai/gpt-5.5",
      ttftMs: 150,
      generationMs: 500,
      totalMs: 800,
      tokens: 50,
      tokensEstimated: false,
    });
  });
});
