"use client";

/**
 * Score distribution as a column chart.
 *
 * Replaces the CSS bar list the teacher stats used. A distribution is a shape —
 * where the class piles up, whether it is bimodal — and a column chart shows
 * that in a way a stack of horizontal bars does not.
 *
 * Mark specs: columns capped at `--viz-bar-max` (never filling the band, so the
 * leftover is air), a 2px gap in the surface colour separating neighbours, and
 * the corner radius from `--viz-bar-radius` — square in this theme, which keeps
 * the mark's height the only thing carrying the value. Hover is on by default;
 * the peak is labelled directly, and a table view carries every value for
 * anyone the hover layer does not reach.
 */

import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import type { DistributionBucket } from "@/lib/quiz-stats";

const PLOT_HEIGHT = 168;

export function DistributionChart({
  buckets,
  title,
  className,
}: {
  buckets: DistributionBucket[];
  /** Names what is plotted, which is why a single-series chart needs no legend. */
  title: string;
  className?: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const tableId = useId();

  const peak = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const peakIndex = buckets.findIndex((bucket) => bucket.count === peak);

  if (buckets.length === 0) {
    return <p className={cn("text-sm text-muted-foreground", className)}>No attempts yet.</p>;
  }

  return (
    <figure className={cn("viz-root", className)}>
      <figcaption className="mb-3 text-sm font-medium">{title}</figcaption>

      <div className="relative flex items-end gap-[2px]" style={{ height: PLOT_HEIGHT }}>
        {buckets.map((bucket, index) => {
          const ratio = bucket.count / peak;
          const active = hovered === index;
          return (
            <div
              key={bucket.label}
              className="group relative flex h-full flex-1 flex-col justify-end"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(null)}
            >
              {/* Direct label on the peak only. A number on every column is
                  chaos and goes unread; the rest are in the tooltip and table. */}
              {index === peakIndex && bucket.count > 0 && (
                <span className="mb-1 text-center text-xs font-medium tabular-nums text-muted-foreground">
                  {bucket.count}
                </span>
              )}
              <button
                type="button"
                aria-label={`${bucket.label}: ${bucket.count} attempt${bucket.count === 1 ? "" : "s"}`}
                aria-describedby={tableId}
                className="mx-auto w-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  // Capped, so a wide card gives air rather than a fat block.
                  maxWidth: "var(--viz-bar-max)",
                  height: `${Math.max(ratio * 100, bucket.count > 0 ? 2 : 0)}%`,
                  background: "var(--viz-series-1)",
                  borderRadius: "var(--viz-bar-radius) var(--viz-bar-radius) 0 0",
                  opacity: hovered === null || active ? 1 : 0.55,
                  transformOrigin: "bottom",
                  animation: "viz-bar-grow var(--motion-slow) var(--ease-standard)",
                }}
              />

              {active && bucket.count > 0 && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 w-max -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground [box-shadow:var(--shadow-overlay)]"
                >
                  <span className="font-medium">{bucket.label}</span>
                  <span className="ml-2 tabular-nums text-muted-foreground">
                    {bucket.count} · {total > 0 ? Math.round((bucket.count / total) * 100) : 0}%
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Baseline: the one rule the columns actually sit on. */}
      <div className="mt-0 h-px w-full" style={{ background: "var(--viz-grid)" }} />

      <div className="mt-1.5 flex gap-[2px]">
        {buckets.map((bucket) => (
          <span
            key={bucket.label}
            className="flex-1 text-center text-[11px] text-muted-foreground"
          >
            {bucket.label}
          </span>
        ))}
      </div>

      {/* The relief the palette validation asks for, and the accessible path to
          the numbers regardless of whether hover is available. */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          View as table
        </summary>
        <table id={tableId} className="mt-2 w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-1 font-medium">Score</th>
              <th className="py-1 text-right font-medium">Attempts</th>
              <th className="py-1 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.label} className="border-b border-border/50">
                <td className="py-1">{bucket.label}</td>
                <td className="py-1 text-right tabular-nums">{bucket.count}</td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">
                  {total > 0 ? Math.round((bucket.count / total) * 100) : 0}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
