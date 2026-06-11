"use client";

import { useCallback, useRef, useState } from "react";
import type { FigureBbox } from "@/lib/quiz-extraction";

type DragMode = "move" | "resize" | null;

/**
 * Adjustable crop overlay drawn on top of a source page image. The bbox is kept
 * in normalized 0..1 page coordinates (the same space the server stores and the
 * commit re-reads to draw the crop). Drag the rectangle body to move it, the
 * bottom-right handle to resize. Pointer events on absolutely-positioned divs —
 * no extra dependency.
 */
export function FigureCropper({
  pageUrl,
  bbox,
  onChange,
}: {
  pageUrl: string;
  bbox: FigureBbox;
  onChange: (next: FigureBbox) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<DragMode>(null);
  // Pointer position (normalized) at drag start, plus the bbox at that moment.
  const startRef = useRef<{ px: number; py: number; box: FigureBbox } | null>(null);

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

  const normalizedPoint = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return { px: 0, py: 0 };
    const rect = el.getBoundingClientRect();
    return {
      px: clamp01((clientX - rect.left) / rect.width),
      py: clamp01((clientY - rect.top) / rect.height),
    };
  }, []);

  const onPointerDown = useCallback(
    (nextMode: Exclude<DragMode, null>) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      const { px, py } = normalizedPoint(e.clientX, e.clientY);
      startRef.current = { px, py, box: bbox };
      setMode(nextMode);
    },
    [bbox, normalizedPoint]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!mode || !startRef.current) return;
      const { px, py } = normalizedPoint(e.clientX, e.clientY);
      const { px: sx, py: sy, box } = startRef.current;
      const dx = px - sx;
      const dy = py - sy;

      if (mode === "move") {
        const x = clamp01(Math.min(box.x + dx, 1 - box.w));
        const y = clamp01(Math.min(box.y + dy, 1 - box.h));
        onChange({ x, y, w: box.w, h: box.h });
      } else {
        // Resize from the bottom-right corner; keep a minimum size and stay in bounds.
        const w = Math.min(1 - box.x, Math.max(0.02, box.w + dx));
        const h = Math.min(1 - box.y, Math.max(0.02, box.h + dy));
        onChange({ x: box.x, y: box.y, w, h });
      }
    },
    [mode, normalizedPoint, onChange]
  );

  const endDrag = useCallback(() => {
    setMode(null);
    startRef.current = null;
  }, []);

  const pct = (v: number) => `${v * 100}%`;

  return (
    <div
      ref={containerRef}
      className="relative inline-block max-w-full touch-none select-none overflow-hidden rounded border"
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Plain <img>: the src is a short-lived presigned S3 URL, not a static
          asset, so next/image can't optimize it. Mirrors QuizReviewResult's
          presigned-image img. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={pageUrl} alt="Source page" className="block max-h-[28rem] w-auto max-w-full" draggable={false} />

      {/* Dim everything outside the crop with a ring around the selection. */}
      <div
        className="absolute cursor-move border-2 border-sky-500 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
        style={{ left: pct(bbox.x), top: pct(bbox.y), width: pct(bbox.w), height: pct(bbox.h) }}
        onPointerDown={onPointerDown("move")}
      >
        <div
          className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize rounded-sm border-2 border-sky-500 bg-white"
          onPointerDown={onPointerDown("resize")}
        />
      </div>
    </div>
  );
}
