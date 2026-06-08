import { BookOpen } from "lucide-react";
import type { PresignedRecommendation } from "@/lib/exam-results";

/**
 * One learning-material recommendation, sized to sit beside the question it
 * addresses. The page images live in a fixed-height, scrollable box so a
 * recommendation with several pages doesn't stretch the row into a long strip.
 */
export function RecommendationCard({ rec }: { rec: PresignedRecommendation }) {
  return (
    <div className="flex h-full flex-col rounded-xl border bg-card p-4 text-sm shadow-sm">
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
        // Document viewer: the box is exactly one page tall; additional pages are
        // reached by scrolling, snapping one page into view at a time.
        <div className="mt-3 aspect-[4/3] w-full snap-y snap-mandatory overflow-y-auto rounded-lg border bg-muted/30">
          {rec.pages.map((pg) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={pg.pageNumber}
              src={pg.imageUrl}
              alt={`Page ${pg.pageNumber} of ${rec.materialTitle}`}
              loading="lazy"
              className="block h-full w-full snap-start object-contain"
            />
          ))}
        </div>
      )}
      {rec.pages.length > 1 && (
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
          Scroll for {rec.pages.length - 1} more page{rec.pages.length - 1 > 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}
