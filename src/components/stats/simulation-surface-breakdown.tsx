import {
  formatDurationMs,
  type SimulationSurfaceRow,
} from "@/lib/simulation-stats";

/**
 * Compact "where students opened simulations" table for the teacher/admin
 * stats views. One row per launch surface; legacy (pre-pop-up) values keep
 * their own labelled rows.
 */
export function SimulationSurfaceBreakdown({
  rows,
}: {
  rows: SimulationSurfaceRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full text-sm"
        aria-label="Simulation opens by launch point"
      >
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Opened from</th>
            <th className="py-2 px-3 font-medium text-right">Opens</th>
            <th className="py-2 px-3 font-medium text-right">Students</th>
            <th className="py-2 px-3 font-medium text-right">Median active</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.surface} className="border-b last:border-0">
              <td className="py-2 pr-3">{row.label}</td>
              <td className="py-2 px-3 text-right tabular-nums">{row.opens}</td>
              <td className="py-2 px-3 text-right tabular-nums">
                {row.uniqueStudents}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {formatDurationMs(row.medianActiveMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
