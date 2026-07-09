import { Loader2, Sparkles } from "lucide-react";
import { RecommendationCard } from "@/components/student/RecommendationCard";
import {
  RESULT_STATUS,
  type ResultStatus,
  type PresignedRecommendation,
} from "@/lib/exam-results";

/**
 * The student-facing study-material recommendations: up to 3 holistic cards
 * chosen across the whole attempt. Deliberately carries NO per-question framing
 * — it never says which questions were wrong, only what to study next.
 */
export function HolisticRecommendations({
  recommendations,
  status,
}: {
  recommendations: PresignedRecommendation[];
  status: ResultStatus;
}) {
  const pending = status === RESULT_STATUS.PENDING || status === RESULT_STATUS.GENERATING;

  return (
    /* Container for the card grid below: column count must follow the
       available width, not the viewport — while a simulation is open this
       section lives in the page's narrow column and the cards must stack
       instead of splitting into slivers. */
    <div className="space-y-3 @container">
      <h2 className="flex items-center gap-1.5 text-lg font-semibold">
        <Sparkles className="size-5 text-primary" /> Study recommendations
      </h2>

      {recommendations.length > 0 ? (
        <div className="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
          {recommendations.map((rec, i) => (
            <RecommendationCard key={`${rec.materialTitle}-${i}`} rec={rec} />
          ))}
        </div>
      ) : pending ? (
        <div className="flex items-center gap-2 rounded-xl border p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-primary" /> Finding study material for you…
        </div>
      ) : (
        <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
          No specific study material to recommend right now — review your class materials to keep
          building on what you know.
        </div>
      )}
    </div>
  );
}
