/**
 * A trend line small enough to sit inside a line of text or a stat tile.
 *
 * No axes, no labels, no hover: a sparkline's job is shape, and the value it
 * would tell you belongs to the number it sits beside. The current point gets an
 * end dot with a 2px ring in the surface colour, which is what keeps it legible
 * where it crosses the line's own tail.
 */

import { cn } from "@/lib/utils";

const WIDTH = 96;
const HEIGHT = 28;
const PAD = 4;

export function Sparkline({
  values,
  /** Describes the trend for screen readers; the visual is decorative without it. */
  label,
  color = "var(--viz-series-1)",
  className,
}: {
  values: number[];
  label: string;
  color?: string;
  className?: string;
}) {
  // One point is not a trend, and zero points is not a chart.
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero; draw it down the middle instead.
  const span = max - min || 1;
  const stepX = (WIDTH - PAD * 2) / (values.length - 1);

  const points = values.map((value, index) => {
    const x = PAD + index * stepX;
    const y = HEIGHT - PAD - ((value - min) / span) * (HEIGHT - PAD * 2);
    return [x, y] as const;
  });
  const last = points[points.length - 1];

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={label}
      className={cn("viz-root overflow-visible", className)}
    >
      <polyline
        points={points.map(([x, y]) => `${x},${y}`).join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="var(--viz-stroke)"
        strokeLinecap="round"
        strokeLinejoin="round"
        // The tail is context; the current value is the point.
        opacity={0.55}
      />
      {/* The last segment carries full weight, so the eye lands on "now". */}
      {points.length >= 2 && (
        <polyline
          points={points
            .slice(-2)
            .map(([x, y]) => `${x},${y}`)
            .join(" ")}
          fill="none"
          stroke={color}
          strokeWidth="var(--viz-stroke)"
          strokeLinecap="round"
        />
      )}
      <circle
        cx={last[0]}
        cy={last[1]}
        r={4}
        fill={color}
        stroke="var(--viz-surface)"
        strokeWidth={2}
      />
    </svg>
  );
}
