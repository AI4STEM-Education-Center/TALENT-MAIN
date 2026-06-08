import { BookOpen } from "lucide-react";
import type { PresignedRecommendation } from "@/lib/exam-results";

/**
 * Renders learning-material recommendations as full-width cards with page
 * images. Adapted from the chatbot's compact card markup for a results page
 * (full-width, stacked images rather than a scrolling thumbnail strip).
 */
export function RecommendationCards({
  recommendations,
  truncated,
}: {
  recommendations: PresignedRecommendation[];
  truncated: boolean;
}) {
  if (recommendations.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-1.5 text-lg font-semibold">
        <BookOpen className="size-5 text-primary" /> Recommended materials
      </h2>
      {recommendations.map((rec) => (
        <div
          key={`${rec.questionText}-${rec.materialTitle}-${rec.pageRange.start}`}
          className="rounded-xl border bg-card p-4 text-sm shadow-sm"
        >
          <p className="mb-1 text-xs text-muted-foreground">
            For: <span className="italic">{rec.questionText}</span>
          </p>
          <p className="font-medium">
            {rec.materialTitle}
            <span className="ml-1 font-normal text-muted-foreground">
              ·{" "}
              {rec.pageRange.start === rec.pageRange.end
                ? `page ${rec.pageRange.start}`
                : `pages ${rec.pageRange.start}–${rec.pageRange.end}`}
            </span>
          </p>
          {(rec.pageReason || rec.fileReason) && (
            <p className="mt-1 text-xs text-muted-foreground">{rec.pageReason || rec.fileReason}</p>
          )}
          {rec.pages.length > 0 && (
            <div className="mt-3 space-y-2">
              {rec.pages.map((pg) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={pg.pageNumber}
                  src={pg.imageUrl}
                  alt={`Page ${pg.pageNumber} of ${rec.materialTitle}`}
                  loading="lazy"
                  className="h-auto w-full rounded-lg border"
                />
              ))}
            </div>
          )}
        </div>
      ))}
      {truncated && (
        <p className="text-xs text-muted-foreground">
          You missed more questions than shown here. Start with these.
        </p>
      )}
    </div>
  );
}
