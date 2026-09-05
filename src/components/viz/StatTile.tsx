/**
 * A single headline metric.
 *
 * Follows the stat-tile contract: label (sentence case, no trailing colon),
 * value, an optional signed delta measured against a named period, and an
 * optional sparkline. The delta's colour is direction × whether up is good —
 * a falling error rate is green — and it always carries an arrow, so the
 * direction survives without colour.
 */

import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "./Sparkline";

export function StatTile({
  label,
  value,
  sub,
  delta,
  trend,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: {
    /** Signed; the sign picks the arrow. */
    value: number;
    /** Rendered after the number, e.g. "vs last week". */
    period: string;
    /** Default true. False for metrics where a rise is bad (misses, failures). */
    upIsGood?: boolean;
    /** Formats the magnitude; defaults to a one-decimal percentage-point delta. */
    format?: (value: number) => string;
  };
  trend?: { values: number[]; label: string };
  className?: string;
}) {
  return (
    <div
      className={cn(
        "surface-card flex flex-col p-[var(--pad-card)]",
        className,
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>

      <div className="mt-2 flex items-end justify-between gap-3">
        {/* Proportional figures — see the note in ScoreDial: tabular digits are
            for columns that must align, not for a standalone number. */}
        <p className="text-3xl font-semibold leading-none">{value}</p>
        {trend && (
          <Sparkline
            values={trend.values}
            label={trend.label}
            className="mb-0.5 shrink-0"
          />
        )}
      </div>

      {delta && <DeltaLine {...delta} />}
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function DeltaLine({
  value,
  period,
  upIsGood = true,
  format = (n: number) => `${Math.abs(n).toFixed(1)} pts`,
}: NonNullable<Parameters<typeof StatTile>[0]["delta"]>) {
  // Treat a hair either side of zero as flat rather than claiming a direction
  // the underlying number does not support.
  const flat = Math.abs(value) < 0.05;
  const good = value > 0 === upIsGood;
  const Icon = flat ? ArrowRight : value > 0 ? ArrowUp : ArrowDown;

  return (
    <p
      className={cn(
        "mt-1.5 flex items-center gap-1 text-xs font-medium",
        flat
          ? "text-muted-foreground"
          : good
            ? "text-[var(--viz-good)]"
            : "text-[var(--viz-critical)]",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">
        {flat ? "No change" : `${value > 0 ? "+" : "−"}${format(value)}`}
      </span>
      <span className="font-normal text-muted-foreground">{period}</span>
    </p>
  );
}
