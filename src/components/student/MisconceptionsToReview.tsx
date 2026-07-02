import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { StoredMisconception } from "@/lib/exam-results";

/**
 * "Possible misconceptions to review" — statements only, chosen from the
 * misconception catalog by the labeling step in exam-results-engine.ts.
 * Deliberately carries NO per-question linkage (keeps the blind-results
 * contract: a student never sees which question triggered which label).
 * Renders nothing when there are no labels (empty catalog match, labeling
 * skipped, or the labeling call failed).
 */
export function MisconceptionsToReview({
  misconceptions,
}: {
  misconceptions: StoredMisconception[];
}) {
  if (misconceptions.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-3 py-5">
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <ShieldAlert className="size-5 text-primary" /> Possible misconceptions to review
        </h2>
        <div className="flex flex-wrap gap-2">
          {misconceptions.map((m) => (
            <Badge
              key={m.misconceptionId}
              variant="secondary"
              className="whitespace-normal text-left font-normal"
            >
              {m.statement}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
