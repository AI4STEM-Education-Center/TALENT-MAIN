"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Hand-rolled SVG time-series chart for the admin resource monitor. The app
// ships no charting library, and one line chart with a crosshair is far less
// code than adding (and auditing) a dependency for it.
//
// Conventions worth keeping if this is ever extended: 2px lines, hairline
// gridlines, a y-axis anchored at zero, series hues assigned by fixed slot (see
// .viz-root in globals.css), and text in text tokens rather than the series
// colour — a hue chosen to be legible as a 2px line is not legible as 11px text.

export interface ChartSeries {
  id: string;
  label: string;
  /** CSS custom property holding this series' hue, e.g. "--viz-series-1". */
  colorVar: string;
  /**
   * Draw dashed. Reserved for the whole-machine series, which is a different
   * kind of quantity from the per-node ones (it contains them) — the dash is
   * what stops it reading as one more node.
   */
  dashed?: boolean;
  points: { t: number; v: number }[];
}

interface ResourceChartProps {
  title: string;
  description: string;
  series: ChartSeries[];
  /** Formats a value for the axis, tooltip, and end labels. */
  format: (value: number) => string;
  /** Fixed axis top (CPU is always 0-100); omit to scale to the data. */
  fixedMax?: number;
  /**
   * Base the axis steps are rounded against. Bytes need 1024 — rounding them
   * decimally produces ticks like "9.3 GiB" where "8 GiB" was meant.
   */
  axisBase?: number;
  /** Bucket width — a wider gap between points means the node was down, and
   * the line breaks rather than drawing a straight line across the outage. */
  gapMs: number;
  height?: number;
  /** Dimmed while a refetch is in flight, so the frame never jumps. */
  stale?: boolean;
}

const PADDING = { top: 14, right: 64, bottom: 26, left: 62 };
const TICK_COUNT = 4;

/**
 * Legend/tooltip swatch. Dashed series get a dashed swatch — the key has to
 * carry the same distinction the line does, or the dash is unexplained.
 */
function seriesSwatchStyle(series: ChartSeries): React.CSSProperties {
  const color = `var(${series.colorVar})`;
  if (!series.dashed) return { backgroundColor: color };
  return {
    backgroundImage: `repeating-linear-gradient(to right, ${color} 0 4px, transparent 4px 7px)`,
  };
}

/** Axis top rounded up to a readable step (1 / 2 / 2.5 / 5 × a power of `base`). */
function niceMax(value: number, base: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const rough = value / TICK_COUNT;
  const magnitude = base ** Math.floor(Math.log(rough) / Math.log(base));
  const normalized = rough / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : base) * magnitude;
  return step * TICK_COUNT;
}

function formatClock(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs > 36 * 60 * 60 * 1000) {
    // react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- called only from the client-polled chart, which renders no samples during SSR
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  // react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- called only from the client-polled chart, which renders no samples during SSR
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function ResourceChart({
  title,
  description,
  series,
  format,
  fixedMax,
  axisBase = 10,
  gapMs,
  height = 224,
  stale = false,
}: ResourceChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(320, entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => {
    // Nodes sample independently, so their timestamps only mostly line up. The
    // union of every series' bucket starts is the x-domain and the crosshair's
    // snap positions; each series then looks itself up per timestamp.
    const stamps = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b);
    const values = series.flatMap((s) => s.points.map((p) => p.v));
    const dataMax = values.length ? Math.max(...values) : 0;
    return {
      stamps,
      tMin: stamps[0] ?? 0,
      tMax: stamps[stamps.length - 1] ?? 1,
      // Zero-anchored: a truncated axis exaggerates every wobble.
      yMax: fixedMax ?? niceMax(dataMax, axisBase),
      lookup: new Map(series.map((s) => [s.id, new Map(s.points.map((p) => [p.t, p.v]))])),
    };
  }, [series, fixedMax, axisBase]);

  const { stamps, tMin, tMax, yMax, lookup } = model;
  const plotWidth = Math.max(1, width - PADDING.left - PADDING.right);
  const plotHeight = Math.max(1, height - PADDING.top - PADDING.bottom);
  const spanMs = Math.max(1, tMax - tMin);

  const x = useCallback(
    (t: number) => PADDING.left + ((t - tMin) / spanMs) * plotWidth,
    [tMin, spanMs, plotWidth]
  );
  const y = useCallback(
    (v: number) => PADDING.top + plotHeight - (Math.min(v, yMax) / (yMax || 1)) * plotHeight,
    [plotHeight, yMax]
  );

  const pointerToIndex = useCallback(
    (clientX: number) => {
      const box = wrapperRef.current?.getBoundingClientRect();
      if (!box || stamps.length === 0) return null;
      const target = tMin + ((clientX - box.left - PADDING.left) / plotWidth) * spanMs;
      let best = 0;
      for (let i = 1; i < stamps.length; i += 1) {
        if (Math.abs(stamps[i] - target) < Math.abs(stamps[best] - target)) best = i;
      }
      return best;
    },
    [stamps, tMin, spanMs, plotWidth]
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (stamps.length === 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      setActiveIndex((current) => {
        const next = (current ?? stamps.length - 1) + step;
        return Math.max(0, Math.min(stamps.length - 1, next));
      });
    } else if (event.key === "Escape") {
      setActiveIndex(null);
    }
  };

  const hasData = stamps.length > 0 && series.some((s) => s.points.length > 0);
  const activeStamp = activeIndex !== null ? stamps[activeIndex] : null;

  // End labels are the direct-label channel (two of the four light-mode hues
  // sit under 3:1 against the card, so the numbers must be readable as text).
  // Converging lines would stack their labels into an unreadable pile, so a
  // label that would collide is dropped — the node cards above still show
  // every current value.
  const endLabels: { id: string; label: string; yPos: number }[] = [];
  for (const s of series) {
    const last = s.points[s.points.length - 1];
    if (!last) continue;
    const yPos = y(last.v);
    if (endLabels.some((placed) => Math.abs(placed.yPos - yPos) < 13)) continue;
    endLabels.push({ id: s.id, label: format(last.v), yPos });
  }

  const yTicks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => (yMax / TICK_COUNT) * i);
  const xTickCount = Math.max(2, Math.min(6, Math.floor(plotWidth / 110)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => tMin + (spanMs / (xTickCount - 1)) * i);

  return (
    <section className="viz-root border border-border rounded-lg bg-card p-5">
      <header className="mb-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>

      {/* Legend: identity never rests on colour-matching alone. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="h-0.5 w-4 rounded-full" style={seriesSwatchStyle(s)} />
            {s.label}
          </li>
        ))}
      </ul>

      <div
        ref={wrapperRef}
        className={cn("relative transition-opacity", stale && "opacity-60")}
      >
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title}. ${description}`}
          tabIndex={0}
          className="touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          onPointerMove={(e) => setActiveIndex(pointerToIndex(e.clientX))}
          onPointerLeave={() => setActiveIndex(null)}
          onKeyDown={handleKeyDown}
          onBlur={() => setActiveIndex(null)}
        >
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={PADDING.left}
                x2={PADDING.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--viz-grid)"
                strokeWidth={1}
              />
              <text
                x={PADDING.left - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {format(tick)}
              </text>
            </g>
          ))}

          {hasData &&
            xTicks.map((tick) => (
              <text
                key={tick}
                x={x(tick)}
                y={height - 8}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {formatClock(tick, spanMs)}
              </text>
            ))}

          {series.map((s) => {
            let path = "";
            let previousT: number | null = null;
            for (const point of s.points) {
              const command = previousT === null || point.t - previousT > gapMs * 1.5 ? "M" : "L";
              path += `${command}${x(point.t).toFixed(1)} ${y(point.v).toFixed(1)} `;
              previousT = point.t;
            }
            return (
              <path
                key={s.id}
                d={path.trim()}
                fill="none"
                stroke={`var(${s.colorVar})`}
                strokeWidth={2}
                strokeDasharray={s.dashed ? "5 4" : undefined}
                strokeLinecap={s.dashed ? "butt" : "round"}
                strokeLinejoin="round"
              />
            );
          })}

          {activeStamp !== null && (
            <line
              x1={x(activeStamp)}
              x2={x(activeStamp)}
              y1={PADDING.top}
              y2={PADDING.top + plotHeight}
              stroke="var(--viz-grid)"
              strokeWidth={1}
            />
          )}

          {series.map((s) => {
            const last = s.points[s.points.length - 1];
            const hovered = activeStamp !== null ? lookup.get(s.id)?.get(activeStamp) : undefined;
            const dot = hovered !== undefined ? { t: activeStamp as number, v: hovered } : last;
            if (!dot) return null;
            return (
              <circle
                key={s.id}
                cx={x(dot.t)}
                cy={y(dot.v)}
                r={4}
                fill={`var(${s.colorVar})`}
                // Surface ring keeps overlapping end-dots legible.
                stroke="var(--viz-surface)"
                strokeWidth={2}
              />
            );
          })}

          {activeStamp === null &&
            endLabels.map((label) => (
              <text
                key={label.id}
                x={PADDING.left + plotWidth + 10}
                y={label.yPos}
                dominantBaseline="middle"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {label.label}
              </text>
            ))}
        </svg>

        {!hasData && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            No samples in this range yet.
          </p>
        )}

        {activeStamp !== null && (
          <div
            className="pointer-events-none absolute z-10 min-w-40 rounded-md border border-border bg-popover p-2 shadow-md"
            style={{
              left: Math.min(Math.max(x(activeStamp) + 12, 8), Math.max(8, width - 180)),
              top: PADDING.top,
            }}
          >
            <p className="text-[10px] text-muted-foreground mb-1">
              {/* react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- activeStamp comes from client-polled samples and hover state, neither of which exists during SSR */}
              {new Date(activeStamp).toLocaleString()}
            </p>
            {series.map((s) => {
              const value = lookup.get(s.id)?.get(activeStamp);
              return (
                <p key={s.id} className="flex items-center gap-1.5 text-xs">
                  <span
                    aria-hidden
                    className="h-0.5 w-3 shrink-0 rounded-full"
                    style={seriesSwatchStyle(s)}
                  />
                  {/* Value leads, series name follows — the reader already
                      knows which series they are pointing at. */}
                  <span className="font-semibold tabular-nums">
                    {value === undefined ? "–" : format(value)}
                  </span>
                  <span className="text-muted-foreground truncate">{s.label}</span>
                </p>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
