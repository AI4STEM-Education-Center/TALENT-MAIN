import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { DistributionBucket } from "@/lib/quiz-stats";
import { pct, ratePct } from "@/lib/stats-format";


/** A single headline metric in a card. */
export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-bold leading-none">{value}</p>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

/** Score-distribution histogram drawn with CSS bars (no chart dependency). */
export function DistributionBars({ buckets }: { buckets: DistributionBucket[] }) {
  const peak = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="space-y-2">
      {buckets.map((b) => (
        <div key={b.label} className="flex items-center gap-3 text-sm">
          <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{b.label}</span>
          <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
            <div
              className="h-full rounded bg-primary/70"
              style={{ width: `${(b.count / peak) * 100}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-xs tabular-nums text-muted-foreground">{b.count}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A labeled horizontal bar for a 0-1 rate (e.g. per-question correctness). The
 * bar tints red→amber→green as the rate rises so weak spots stand out.
 */
export function RateBar({ label, rate, caption }: { label: ReactNode; rate: number; caption?: string }) {
  const color = rate >= 0.75 ? "bg-green-500/70" : rate >= 0.5 ? "bg-amber-500/70" : "bg-red-500/70";
  return (
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-3 text-sm">
        <span className="min-w-0 flex-1">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{ratePct(rate)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-muted">
        <div className={`h-full rounded ${color}`} style={{ width: `${Math.round(rate * 100)}%` }} />
      </div>
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    </div>
  );
}
