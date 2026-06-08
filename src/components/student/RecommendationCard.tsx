import { BookOpen } from "lucide-react";
import type { PresignedRecommendation } from "@/lib/exam-results";

/**
 * One learning-material recommendation, sized to sit beside the question it
 * addresses. The page images live in a fixed-height, scrollable box so a
 * recommendation with several pages doesn't stretch the row into a long strip.
 */
export function RecommendationCard({ rec }: { rec: PresignedRecommendation }) {
  return (
    <div className="rounded-xl border bg-card p-4 text-sm shadow-sm">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
        <BookOpen className="size-4" /> Recommended material
      </p>
      <p className="mt-1 font-medium">
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
        <div className="mt-3 max-h-96 space-y-2 overflow-y-auto rounded-lg border bg-muted/30 p-2">
          {rec.pages.map((pg) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={pg.pageNumber}
              src={pg.imageUrl}
              alt={`Page ${pg.pageNumber} of ${rec.materialTitle}`}
              loading="lazy"
              className="h-auto w-full rounded-md border"
            />
          ))}
        </div>
      )}
    </div>
  );
}
