"use client";

import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type ReaderPage = {
  id: string;
  pageNumber: number;
  keyConcept: string | null;
  description: string | null;
};

/**
 * Page-by-page reader for a learning material. Page images are signed one at a
 * time by /api/student/materials/[materialId]/pages/[pageId]/image, so a long
 * reading session never runs into an expired batch of URLs and the enrollment
 * gate is re-checked on every fetch.
 */
export function MaterialReader({
  materialId,
  originalName,
  pages,
}: {
  materialId: string;
  originalName: string;
  pages: ReaderPage[];
}) {
  const [index, setIndex] = useState(0);
  const current = pages[index];
  const pageId = current?.id;

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(pages.length > 0);
  const [failed, setFailed] = useState(false);

  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect -- every post-await write is guarded by `signal.aborted`, and the effect aborts on cleanup
  useEffect(() => {
    if (!pageId) return;
    const controller = new AbortController();
    const { signal } = controller;

    // Paging quickly puts several requests in flight; only the one that still
    // owns this controller may write state, or a stale response wins.
    setImageUrl(null);
    setFailed(false);
    setLoading(true);

    void (async () => {
      try {
        const res = await fetch(
          `/api/student/materials/${materialId}/pages/${pageId}/image`,
          { signal },
        );
        if (!res.ok)
          throw new Error(`Page image request failed (HTTP ${res.status})`);
        const data = await res.json();
        if (signal.aborted) return;
        setImageUrl(typeof data?.url === "string" ? data.url : null);
      } catch {
        // An abort is the expected path when the page changes mid-flight.
        if (signal.aborted) return;
        setFailed(true);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [materialId, pageId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          {/* The API mints the signature per click, so this href never goes stale. */}
          <a
            href={`/api/student/materials/${materialId}/file`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="size-4" /> Open original PDF
          </a>
        </Button>
        <span className="text-xs text-muted-foreground">{originalName}</span>
      </div>

      {pages.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            This material has no page previews yet — open the original PDF
            above.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
          <Card className="overflow-hidden">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                  disabled={index === 0}
                >
                  <ChevronLeft className="size-4" /> Previous
                </Button>
                <span className="text-sm font-medium">
                  Page {current.pageNumber} of {pages.length}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setIndex((i) => Math.min(pages.length - 1, i + 1))
                  }
                  disabled={index === pages.length - 1}
                >
                  Next <ChevronRight className="size-4" />
                </Button>
              </div>

              <div className="flex min-h-64 items-center justify-center rounded-md bg-muted/30 p-2">
                {loading ? (
                  <span className="flex flex-col items-center text-sm text-muted-foreground">
                    <Loader2 className="mb-2 size-8 animate-spin text-primary" />
                    Loading page…
                  </span>
                ) : failed || !imageUrl ? (
                  <span className="flex flex-col items-center text-sm text-muted-foreground">
                    <ImageIcon className="mb-2 size-10 opacity-50" />
                    This page could not be loaded.
                  </span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl}
                    alt={`Page ${current.pageNumber}`}
                    className="max-w-full rounded border bg-white"
                  />
                )}
              </div>

              {(current.keyConcept || current.description) && (
                <div className="space-y-1 rounded-md border bg-card p-3">
                  {current.keyConcept && (
                    <p className="text-sm font-semibold">
                      {current.keyConcept}
                    </p>
                  )}
                  {current.description && (
                    <p className="text-sm text-muted-foreground">
                      {current.description}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="lg:sticky lg:top-4">
            <CardContent className="p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Jump to page
              </p>
              <div className="flex max-h-72 flex-wrap gap-1.5 overflow-y-auto">
                {pages.map((page, i) => (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-current={i === index ? "true" : undefined}
                    className={cn(
                      "size-9 rounded-md border text-xs font-medium transition-colors",
                      i === index
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                    )}
                  >
                    {page.pageNumber}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
