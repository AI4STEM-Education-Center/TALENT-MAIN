import { Badge } from "@/components/ui/badge";

/** Color-coded confidence badge for a Concept<->Misconception mapping row. */
export function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  if (!confidence)
    return <span className="text-xs text-muted-foreground">—</span>;

  const normalized = confidence.trim().toLowerCase();
  if (normalized === "high") return <Badge variant="success">High</Badge>;
  if (normalized === "medium") return <Badge variant="warning">Medium</Badge>;
  if (normalized === "low") return <Badge variant="destructive">Low</Badge>;
  return <Badge variant="secondary">{confidence}</Badge>;
}
