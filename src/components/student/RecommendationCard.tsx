"use client";

import { useState } from "react";
import { BookOpen, Maximize2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PresignedRecommendation } from "@/lib/exam-results";

/** "page 8" / "pages 8–12" for a recommendation's range. */
function pageRangeLabel(rec: PresignedRecommendation): string {
  const { start, end } = rec.pageRange;
  return start === end ? `page ${start}` : `pages ${start}–${end}`;
}

/**
 * One learning-material recommendation. The card is a compact teaser sized to
 * sit in the results grid — the pages are too small to read there, so it opens
 * a full-size dialog viewer on click rather than making the student squint at
 * (or scroll inside) a thumbnail.
 */
export function RecommendationCard({ rec }: { rec: PresignedRecommendation }) {
  const [open, setOpen] = useState(false);
  const cover = rec.pages[0];
  const pageCount = rec.pages.length;

  const heading = (
    <>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
        <BookOpen className="size-4" /> Recommended material
      </p>
      <p className="mt-1 font-medium">
        {rec.materialTitle}
        <span className="ml-1 font-normal text-muted-foreground">
          · {pageRangeLabel(rec)}
        </span>
      </p>
    </>
  );

  // Nothing to enlarge (every page presign failed) — render the text alone
  // rather than a control that opens an empty viewer.
  if (pageCount === 0) {
    return (
      <div className="flex h-full flex-col rounded-xl border bg-card p-4 text-sm shadow-xs">
        {heading}
        {rec.reason && <p className="mt-1 text-xs text-muted-foreground">{rec.reason}</p>}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${rec.materialTitle}, ${pageRangeLabel(rec)}`}
        className="group flex h-full cursor-pointer flex-col rounded-xl border bg-card p-4 text-left text-sm shadow-xs transition hover:border-primary/50 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        {heading}
        {rec.reason && <p className="mt-1 text-xs text-muted-foreground">{rec.reason}</p>}

        {/* Cover page only: a single static thumbnail that reads as "there is
            more behind this", instead of a scrollable box pretending to be a
            document viewer. */}
        <div className="relative mt-3 aspect-4/3 w-full overflow-hidden rounded-lg border bg-muted/30">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cover.imageUrl}
            alt={`Page ${cover.pageNumber} of ${rec.materialTitle}`}
            loading="lazy"
            className="size-full object-contain"
          />
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-background/85 py-1.5 text-[11px] font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Maximize2 className="size-3.5" />
            {pageCount > 1 ? `View all ${pageCount} pages` : "View page"}
          </span>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
          Click to read {pageCount > 1 ? `all ${pageCount} pages` : "this page"}
        </p>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* Header stays put while the pages scroll under it. */}
        <DialogContent className="grid max-h-[92vh] w-[95vw] max-w-5xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="pr-8">{rec.materialTitle}</DialogTitle>
            <DialogDescription>
              {pageRangeLabel(rec)}
              {rec.reason ? ` — ${rec.reason}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="snap-y snap-mandatory space-y-4 overflow-y-auto rounded-lg bg-muted/30 p-3">
            {rec.pages.map((pg) => (
              <figure key={pg.pageNumber} className="snap-start">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pg.imageUrl}
                  alt={`Page ${pg.pageNumber} of ${rec.materialTitle}`}
                  loading="lazy"
                  className="mx-auto max-h-[75vh] w-auto max-w-full rounded-md bg-background object-contain shadow-xs"
                />
                <figcaption className="mt-1.5 text-center text-xs text-muted-foreground">
                  Page {pg.pageNumber}
                </figcaption>
              </figure>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
