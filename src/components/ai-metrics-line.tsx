import { formatAiMetrics, type DisplayAiMetrics } from "@/lib/ai-metrics";

interface AiMetricsLineProps {
  metrics: DisplayAiMetrics;
  className?: string;
  prefix?: string;
}

/** Compact persisted AI-generation stats shared across staff and student views. */
export function AiMetricsLine({
  metrics,
  className,
  prefix = "Extracted by ",
}: AiMetricsLineProps) {
  // These diagnostics are useful while validating AI functions on the dev
  // site, but model/provider and timing details are intentionally absent from
  // the production UI. NEXT_PUBLIC_APP_ENV is fixed per deployment build.
  if (process.env.NEXT_PUBLIC_APP_ENV === "prod") return null;

  const text = formatAiMetrics(metrics);
  if (!text) return null;

  return (
    <span className={className}>
      {prefix}
      {text}
      {" "}
      <span className="inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
        Dev site only
      </span>
    </span>
  );
}
