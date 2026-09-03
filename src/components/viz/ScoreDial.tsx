/**
 * The hero figure for an attempt: one score, drawn as a radial meter.
 *
 * There is exactly one of these per view — it is the number the page is about.
 * The arc is a meter, not a categorical mark, so it wears a status colour and
 * the unfilled track is a recessive step of the same idea rather than a second
 * hue competing with it.
 *
 * The sweep is a CSS keyframe rather than a rAF loop: the browser runs it off
 * the main thread, it costs nothing after it finishes, and the global
 * prefers-reduced-motion rule already collapses it to a static arc for anyone
 * who asked for that. No JavaScript runs on mount at all, which is why this is
 * safe to render server-side.
 */

import { cn } from "@/lib/utils";
import { scoreBand } from "./palette";

const SIZE = 168;
const STROKE = 14;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ScoreDial({
  /** 0–100. */
  score,
  label = "Score",
  caption,
  className,
}: {
  score: number;
  label?: string;
  caption?: string;
  className?: string;
}) {
  const clamped = Math.min(Math.max(score, 0), 100);
  const band = scoreBand(clamped / 100);
  const offset = CIRCUMFERENCE * (1 - clamped / 100);

  return (
    <figure className={cn("viz-root flex flex-col items-center gap-2", className)}>
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={`${label}: ${Math.round(clamped)} out of 100 — ${band.label}`}
          // Start the sweep at 12 o'clock and run clockwise.
          className="-rotate-90"
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            stroke="currentColor"
            // The track is the meter's own idea at low emphasis, so the state
            // reads across the whole ring rather than only where it is filled.
            className="text-muted"
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            stroke={band.color}
            strokeDasharray={CIRCUMFERENCE}
            style={{
              // Both ends of the keyframe, supplied per instance.
              ["--dial-circumference" as string]: `${CIRCUMFERENCE}`,
              ["--dial-offset" as string]: `${offset}`,
              strokeDashoffset: offset,
              animation: "viz-dial-sweep var(--motion-slow) var(--ease-standard)",
            }}
          />
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {/* Proportional figures, not tabular: this is a standalone number, and
              tabular digits read loose at display sizes. */}
          <span
            className="font-semibold leading-none"
            style={{ fontSize: "var(--hero-size)" }}
          >
            {Math.round(clamped)}
          </span>
          <span className="mt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
        </div>
      </div>

      {/* The word is the point: on a light surface the warning step is below 3:1
          on purpose, so the colour is never the only thing saying how it went. */}
      <figcaption className="flex flex-col items-center gap-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <span
            aria-hidden="true"
            className="size-2.5 rounded-full"
            style={{ background: band.color }}
          />
          {band.label}
        </span>
        {caption && <span className="text-xs text-muted-foreground">{caption}</span>}
      </figcaption>
    </figure>
  );
}
