import type { ProviderType } from "./ai-provider";
import {
  aggregateMetrics,
  type AiCallMetrics,
} from "./ai-streaming";
import type { DisplayAiMetrics } from "./ai-metrics";

export type StoredSimulationMetrics = {
  aiModel: string | null;
  aiTtftMs: number | null;
  aiGenerationMs: number | null;
  aiTotalMs: number | null;
  aiTokens: number | null;
  aiTokensEstimated: boolean | null;
};

const qualifyModel = (providerType: ProviderType, model: string): string =>
  model.startsWith(`${providerType}/`) ? model : `${providerType}/${model}`;

/**
 * Aggregate one simulation job's calls into the fields persisted on its row.
 * Generation time sums only the post-TTFT windows, which stays accurate when
 * a job contains several calls.
 */
export function buildSimulationMetrics(
  providerType: ProviderType,
  calls: AiCallMetrics[]
): StoredSimulationMetrics {
  const aggregate = aggregateMetrics(calls);
  if (!aggregate) {
    return {
      aiModel: null,
      aiTtftMs: null,
      aiGenerationMs: null,
      aiTotalMs: null,
      aiTokens: null,
      aiTokensEstimated: null,
    };
  }

  return {
    aiModel: qualifyModel(providerType, aggregate.model),
    aiTtftMs: aggregate.ttftMs,
    aiGenerationMs: calls.reduce(
      (sum, call) =>
        sum +
        (call.ttftMs === null
          ? 0
          : Math.max(0, call.totalMs - call.ttftMs)),
      0
    ),
    aiTotalMs: aggregate.totalMs,
    aiTokens: aggregate.completionTokens,
    aiTokensEstimated: aggregate.tokensEstimated,
  };
}

/** Convert stored field names into the shared display component's contract. */
export function simulationMetricsView(
  stored: StoredSimulationMetrics
): DisplayAiMetrics {
  return {
    model: stored.aiModel,
    ttftMs: stored.aiTtftMs,
    generationMs: stored.aiGenerationMs,
    totalMs: stored.aiTotalMs,
    tokens: stored.aiTokens,
    tokensEstimated: stored.aiTokensEstimated,
  };
}
