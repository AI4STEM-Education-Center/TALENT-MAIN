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
    async function loadUrl() {
      try {
        const res = await fetch(`/api/classes/${classId}/materials/${materialId}/pages/${pageId}/image`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        setImageUrl(data.url);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    }
    loadUrl();
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
      className="max-w-full h-auto object-contain rounded border border-gray-200 shadow-sm"
      loading="lazy"
    />
  );
}
