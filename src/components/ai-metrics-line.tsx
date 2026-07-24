import { formatAiMetrics, type DisplayAiMetrics } from "@/lib/ai-metrics";

interface AiMetricsLineProps {
  metrics: DisplayAiMetrics;
  className?: string;
  prefix?: string;
}

/** Compact persisted extraction stats shared by teacher and admin material lists. */
export function AiMetricsLine({
  metrics,
  className,
  prefix = "Extracted by ",
}: AiMetricsLineProps) {
  const text = formatAiMetrics(metrics);
  if (!text) return null;

  return (
    <span className={className}>
      {prefix}
      {text}
    </span>
  );
}
