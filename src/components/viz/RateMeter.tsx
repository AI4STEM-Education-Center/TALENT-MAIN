/**
 * A labelled meter for a 0–1 rate — per-question correctness, mastery, coverage.
 *
 * This is a meter, not a bar chart: the fill carries severity, and the unfilled
 * track is a lighter step of the fill's own colour rather than a neutral grey.
 * That is what makes the state readable across the whole width instead of only
 * where the fill reaches.
 *
 * The band's word ("Needs work") rides beside the number, so the reading never
 * depends on telling amber from red — which matters both for colour vision and
 * because the warning step is deliberately below 3:1 on a light surface.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { scoreBand } from "./palette";

export function RateMeter({
  label,
  rate,
  caption,
  /** Hidden when a list of these already carries one band word per row. */
  showBand = true,
  className,
}: {
  label: ReactNode;
  rate: number;
  caption?: string;
  showBand?: boolean;
  className?: string;
}) {
  const clamped = Math.min(Math.max(rate, 0), 1);
  const band = scoreBand(clamped);
  const percent = Math.round(clamped * 100);

  return (
    <div className={cn("viz-root space-y-1.5", className)}>
      <div className="flex items-start justify-between gap-3 text-sm">
        <span className="min-w-0 flex-1">{label}</span>
        <span className="flex shrink-0 items-center gap-2">
          {showBand && (
            <span className="text-xs font-medium text-muted-foreground">
              {band.label}
            </span>
          )}
          <span className="tabular-nums font-medium">{percent}%</span>
        </span>
      </div>

      {/*
        Hidden from assistive tech on purpose. The label, the band word and the
        percentage are all already rendered as text directly above; announcing
        the bar as well would read the same value twice. The bar is a second
        encoding of what the line says, not an extra piece of information.
      */}
      <div
        aria-hidden="true"
        className="h-2 w-full overflow-hidden"
        style={{
          borderRadius: "var(--viz-bar-radius, 2px)",
          // A lighter step of the fill's own colour, not a neutral track.
          background: `color-mix(in oklab, ${band.color} 20%, transparent)`,
        }}
      >
        <div
          className="h-full transition-[width] duration-[var(--motion-slow)] ease-[var(--ease-standard)]"
          style={{
            width: `${percent}%`,
            background: band.color,
            borderRadius: "inherit",
          }}
        />
      </div>

      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    </div>
  );
}
