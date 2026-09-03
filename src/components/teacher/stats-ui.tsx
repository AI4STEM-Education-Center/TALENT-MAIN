/**
 * The teacher stats pieces.
 *
 * These are now thin adapters over the shared viz primitives in
 * components/viz — the histogram is a real column chart with a hover layer and
 * a table view, and the rate bars are meters with a band word beside the
 * number. The names and props are unchanged so the three stats pages did not
 * have to move at the same time.
 */

import type { ReactNode } from "react";
import type { DistributionBucket } from "@/lib/quiz-stats";
import { DistributionChart } from "@/components/viz/DistributionChart";
import { RateMeter } from "@/components/viz/RateMeter";
import { StatTile } from "@/components/viz/StatTile";

/** A single headline metric in a card. */
export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <StatTile label={label} value={value} sub={sub} />;
}

/** Score-distribution histogram. */
export function DistributionBars({
  buckets,
  title = "Score distribution",
}: {
  buckets: DistributionBucket[];
  title?: string;
}) {
  return <DistributionChart buckets={buckets} title={title} />;
}

/**
 * A labeled meter for a 0-1 rate (e.g. per-question correctness). The fill
 * carries severity, and the band's word rides beside it so the reading never
 * depends on telling amber from red.
 */
export function RateBar({
  label,
  rate,
  caption,
}: {
  label: ReactNode;
  rate: number;
  caption?: string;
}) {
  return <RateMeter label={label} rate={rate} caption={caption} />;
}
