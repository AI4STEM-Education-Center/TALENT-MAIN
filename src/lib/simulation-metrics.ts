import type { ProviderType } from "./ai-provider";
import {
  aggregateMetrics,
  type AiCallMetrics,
} from "./ai-streaming";
import type { DisplayAiMetrics } from "./ai-metrics";

export type StoredSimulationMetrics = {
  aiModel: string | null;
  aiProvider: string | null;
  aiServiceTier: string | null;
  aiTtftMs: number | null;
  aiGenerationMs: number | null;
  aiTotalMs: number | null;
  aiTokens: number | null;
  aiTokensEstimated: boolean | null;
};

/** The bits of the resolved provider that describe who served a job's calls. */
export type MetricsProvider = {
  providerType: ProviderType;
  serviceTier: string | null;
};

/**
 * Aggregate one simulation job's calls into the fields persisted on its row.
 * The provider and its service tier are stored beside the model rather than
 * mashed into it — a gateway's model id already carries a vendor prefix
 * ("openai/gpt-5.5" on Cloudflare), so a single string couldn't say who served
 * it. Rows written before these columns existed keep their provider-qualified
 * aiModel and are left exactly as they are.
 *
 * Generation time comes from the aggregate, which reports it only when the
 * calls actually streamed (see `aggregateMetrics`) — null otherwise, so the UI
 * shows no generation window instead of a buffering gateway's flush time.
 */
export function buildSimulationMetrics(
  provider: MetricsProvider,
  calls: AiCallMetrics[]
): StoredSimulationMetrics {
  const aggregate = aggregateMetrics(calls);
  if (!aggregate) {
    return {
      aiModel: null,
      aiProvider: null,
      aiServiceTier: null,
      aiTtftMs: null,
      aiGenerationMs: null,
      aiTotalMs: null,
      aiTokens: null,
      aiTokensEstimated: null,
    };
  }

  return {
    aiModel: aggregate.model,
    aiProvider: provider.providerType,
    aiServiceTier: provider.serviceTier,
    aiTtftMs: aggregate.ttftMs,
    aiGenerationMs: aggregate.generationMs,
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
    provider: stored.aiProvider,
    serviceTier: stored.aiServiceTier,
    ttftMs: stored.aiTtftMs,
    generationMs: stored.aiGenerationMs,
    totalMs: stored.aiTotalMs,
    tokens: stored.aiTokens,
    tokensEstimated: stored.aiTokensEstimated,
  };
}
