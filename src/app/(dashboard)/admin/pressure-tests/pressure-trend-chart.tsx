"use client";

interface TrendPoint {
  id: string;
  createdAt: string;
  p95Ms: number | null;
  status: string;
}

const WIDTH = 900;
const HEIGHT = 230;
const PAD = { top: 18, right: 24, bottom: 38, left: 62 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TICKS = [0, 0.25, 0.5, 0.75, 1];

function formatDate(value: string) {
  const date = new Date(value);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

export function PressureTrendChart({ points }: { points: TrendPoint[] }) {
  const plotted = points
    .filter((point): point is TrendPoint & { p95Ms: number } => point.p95Ms !== null)
    .slice()
    .reverse();
  if (plotted.length === 0) {
    return <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">No latency samples match these filters.</div>;
  }

  const max = Math.max(1, ...plotted.map((point) => point.p95Ms));
  const x = (index: number) =>
    PAD.left + (index / Math.max(1, plotted.length - 1)) * (WIDTH - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + (1 - value / max) * (HEIGHT - PAD.top - PAD.bottom);
  const path = plotted.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point.p95Ms)}`).join(" ");
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="min-w-[640px] w-full"
        role="img"
        aria-label={`P95 latency trend across ${plotted.length} pressure-test results`}
      >
        {TICKS.map((tick) => {
          const value = max * tick;
          const tickY = y(value);
          return (
            <g key={tick}>
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={tickY} y2={tickY} className="stroke-border" strokeDasharray="4 5" />
              <text x={PAD.left - 10} y={tickY + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
                {value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`}
              </text>
            </g>
          );
        })}
        <path d={path} fill="none" className="stroke-primary" strokeWidth="3" strokeLinejoin="round" />
        {plotted.map((point, index) => (
          <g key={point.id}>
            <circle
              cx={x(index)}
              cy={y(point.p95Ms)}
              r="5"
              className={point.status === "PASS" ? "fill-emerald-500" : "fill-red-500"}
            >
              <title>{`${formatDate(point.createdAt)}: ${point.p95Ms.toFixed(1)}ms (${point.status})`}</title>
            </circle>
            {(index === 0 || index === plotted.length - 1) && (
              <text x={x(index)} y={HEIGHT - 12} textAnchor={index === 0 ? "start" : "end"} className="fill-muted-foreground text-[11px]">
                {formatDate(point.createdAt)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
