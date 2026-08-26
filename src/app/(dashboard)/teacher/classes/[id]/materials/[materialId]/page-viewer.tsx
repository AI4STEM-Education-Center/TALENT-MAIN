"use client";

import { useEffect, useState } from "react";
import { Loader2, Image as ImageIcon } from "lucide-react";

export default function PageViewer({
  classId,
  materialId,
  pageId,
}: {
  classId: string;
  materialId: string;
  pageId: string;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    // Flipping pages quickly used to race: two requests were in flight and
    // whichever landed last won, so the viewer could show the wrong page. Reset
    // the previous page's result up front, and let only the request that still
    // owns this controller write state — including the `loading` reset, or an
    // aborted request would clear the spinner belonging to its successor.
    setImageUrl(null);
    setError(false);
    setLoading(true);

    void (async () => {
      try {
        const res = await fetch(
          `/api/classes/${classId}/materials/${materialId}/pages/${pageId}/image`,
          { signal }
        );
        if (!res.ok) throw new Error(`Page image request failed (HTTP ${res.status})`);
        const data = await res.json();
        if (signal.aborted) return;
        setImageUrl(typeof data?.url === "string" ? data.url : null);
      } catch {
        // An abort is the expected path when pageId changes mid-flight.
        if (signal.aborted) return;
        setError(true);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [classId, materialId, pageId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-gray-400">
        <Loader2 className="size-8 animate-spin mb-2 text-blue-500" />
        <span className="text-sm">Loading image…</span>
      </div>
    );
  }

  if (error || !imageUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-gray-400">
        <ImageIcon className="size-10 mb-2 opacity-50" />
        <span className="text-sm">Image unavailable</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt="Document Page"
      className="max-w-full h-auto object-contain rounded border border-gray-200 shadow-xs"
      loading="lazy"
    />
  );
}
