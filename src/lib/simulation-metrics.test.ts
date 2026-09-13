import { describe, expect, it } from "vitest";
import {
  buildSimulationMetrics,
  simulationMetricsView,
} from "./simulation-metrics";
import type { AiCallMetrics } from "./ai-streaming";

const call = (overrides: Partial<AiCallMetrics> = {}): AiCallMetrics => ({
  model: "gpt-5.5",
  ttftMs: 200,
  completionTokens: 20,
  tokensEstimated: false,
  totalMs: 500,
  generationMs: 300,
  tokensPerSec: 20 / 0.3,
  ...overrides,
});

describe("buildSimulationMetrics", () => {
  it("records the provider, tier, and thinking level beside the model, not folded into it", () => {
    expect(
      buildSimulationMetrics(
        {
          providerType: "cloudflare",
          serviceTier: "flex",
          thinkingLevel: "high",
        },
        [
          call({ model: "openai/gpt-5.5" }),
          call({
            model: "openai/gpt-5.5",
            ttftMs: 100,
            totalMs: 300,
            generationMs: 200,
            completionTokens: 30,
            tokensEstimated: true,
          }),
        ],
      ),
    ).toEqual({
      aiModel: "openai/gpt-5.5",
      aiProvider: "cloudflare",
      aiServiceTier: "flex",
      aiThinkingLevel: "high",
      aiTtftMs: 150,
      aiGenerationMs: 500,
      aiTotalMs: 800,
      aiTokens: 50,
      aiTokensEstimated: true,
    });
  });

  it("stores no generation window when a call didn't stream incrementally", () => {
    const metrics = buildSimulationMetrics(
      { providerType: "cloudflare", serviceTier: null, thinkingLevel: null },
      [call(), call({ ttftMs: 6805, totalMs: 6837, generationMs: null })],
    );
    expect(metrics.aiGenerationMs).toBeNull();
    expect(metrics.aiServiceTier).toBeNull();
    expect(metrics.aiThinkingLevel).toBeNull();
  });

  it("returns nullable fields when a job made no model calls", () => {
    expect(
      buildSimulationMetrics(
        { providerType: "local", serviceTier: null, thinkingLevel: null },
        [],
      ),
    ).toEqual({
      aiModel: null,
      aiProvider: null,
      aiServiceTier: null,
      aiThinkingLevel: null,
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
        aiProvider: "cloudflare",
        aiServiceTier: "flex",
        aiThinkingLevel: "high",
        aiTtftMs: 150,
        aiGenerationMs: 500,
        aiTotalMs: 800,
        aiTokens: 50,
        aiTokensEstimated: false,
      }),
    ).toEqual({
      model: "openai/gpt-5.5",
      provider: "cloudflare",
      serviceTier: "flex",
      thinkingLevel: "high",
      ttftMs: 150,
      generationMs: 500,
      totalMs: 800,
      tokens: 50,
      tokensEstimated: false,
    });
  });

  it("carries a pre-provider-column row through untouched", () => {
    // Older rows hold the qualified label in aiModel and no provider/tier/
    // thinking level; the view must not invent any of them.
    expect(
      simulationMetricsView({
        aiModel: "cloudflare/openai/gpt-5.5",
        aiProvider: null,
        aiServiceTier: null,
        aiThinkingLevel: null,
        aiTtftMs: 150,
        aiGenerationMs: 500,
        aiTotalMs: 800,
        aiTokens: 50,
        aiTokensEstimated: false,
      }),
    ).toMatchObject({
      model: "cloudflare/openai/gpt-5.5",
      provider: null,
      serviceTier: null,
    });
  });
});
