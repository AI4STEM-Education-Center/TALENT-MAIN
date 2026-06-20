"use client";

import { useCallback, useRef } from "react";
import type { FigureBbox } from "@/lib/quiz-extraction";

/** One labeled crop region drawn over the page (a question figure or a choice image). */
export type CropBox = { id: string; label: string; bbox: FigureBbox };

type DragMode = "move" | "resize";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const pct = (v: number) => `${v * 100}%`;

/**
 * Adjustable crop overlay that draws the source page image ONCE with any number
 * of labeled boxes on top — used for image answer-choices (one box per choice,
 * plus the question figure). Boxes are kept in normalized 0..1 page coordinates,
 * the same space the commit re-reads to draw each crop. Click a box to select
 * it; drag its body to move, the bottom-right handle to resize. Pointer state is
 * kept in refs (it only matters mid-drag, never rendered) so dragging doesn't
 * trigger extra re-renders. With a single box the exterior is dimmed for focus.
 */
export function MultiBoxCropper({
  pageUrl,
  boxes,
  activeId,
  onSelect,
  onChange,
  imgClassName,
  containerClassName,
}: {
  pageUrl: string;
  boxes: CropBox[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, next: FigureBbox) => void;
  imgClassName?: string;
  containerClassName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<DragMode | null>(null);
  const startRef = useRef<{ px: number; py: number; box: FigureBbox; id: string } | null>(null);

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
    (box: CropBox, nextMode: DragMode) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      onSelect(box.id);
      const { px, py } = normalizedPoint(e.clientX, e.clientY);
      startRef.current = { px, py, box: box.bbox, id: box.id };
      modeRef.current = nextMode;
    },
    [normalizedPoint, onSelect]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const mode = modeRef.current;
      const start = startRef.current;
      if (!mode || !start) return;
      const { px, py } = normalizedPoint(e.clientX, e.clientY);
      const { px: sx, py: sy, box, id } = start;
      const dx = px - sx;
      const dy = py - sy;
      if (mode === "move") {
        const x = clamp01(Math.min(box.x + dx, 1 - box.w));
        const y = clamp01(Math.min(box.y + dy, 1 - box.h));
        onChange(id, { x, y, w: box.w, h: box.h });
      } else {
        // Resize from the bottom-right corner; keep a minimum size and stay in bounds.
        const w = Math.min(1 - box.x, Math.max(0.02, box.w + dx));
        const h = Math.min(1 - box.y, Math.max(0.02, box.h + dy));
        onChange(id, { x: box.x, y: box.y, w, h });
      }
    },
    [normalizedPoint, onChange]
  );

  const endDrag = useCallback(() => {
    modeRef.current = null;
    startRef.current = null;
  }, []);

  const dimExterior = boxes.length === 1;

  return (
    <div
      ref={containerRef}
      className={containerClassName ?? "relative inline-block max-w-full touch-none select-none overflow-hidden rounded border"}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Plain <img>: the src is a short-lived presigned S3 URL, not a static
          asset, so next/image can't optimize it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={pageUrl}
        alt="Source page"
        className={imgClassName ?? "block max-h-[28rem] w-auto max-w-full"}
        draggable={false}
      />

      {boxes.map((b) => {
        const active = b.id === activeId;
        const ring = active && dimExterior ? " shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" : "";
        return (
          <div
            key={b.id}
            className={`absolute cursor-move border-2 ${active ? "border-sky-500" : "border-amber-400/90"}${ring}`}
            style={{ left: pct(b.bbox.x), top: pct(b.bbox.y), width: pct(b.bbox.w), height: pct(b.bbox.h) }}
            onPointerDown={onPointerDown(b, "move")}
          >
            <span
              className={`absolute left-0 top-0 rounded-br px-1 text-[10px] font-semibold leading-tight text-white ${
                active ? "bg-sky-600" : "bg-amber-500"
              }`}
            >
              {b.label}
            </span>
            {active && (
              <div
                className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize rounded-sm border-2 border-sky-500 bg-white"
                onPointerDown={onPointerDown(b, "resize")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
