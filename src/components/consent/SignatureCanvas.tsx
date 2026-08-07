"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import SignaturePad from "signature_pad";
import { cn } from "@/lib/utils";

/**
 * Thin wrapper around signature_pad for capturing hand-drawn initials/
 * signatures. Deliberately exposes `toData()` — signature_pad's own vector
 * point-group format — rather than a rendered PNG: that's the minimal-storage
 * format ConsentRecord.initialsStrokeData/signatureStrokeData store, a few
 * hundred bytes to a couple KB instead of tens of KB as an image.
 */

export interface SignatureCanvasHandle {
  clear: () => void;
  isEmpty: () => boolean;
  /** signature_pad's PointGroup[] shape, or null when nothing has been drawn. */
  toData: () => unknown;
}

export const SignatureCanvas = forwardRef<
  SignatureCanvasHandle,
  { className?: string; height?: number }
>(function SignatureCanvas({ className, height = 120 }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Size the backing pixel buffer to the element's CSS size × device pixel
    // ratio once at mount, so strokes are crisp on high-DPI displays. Not
    // re-run on window resize (which would wipe an in-progress drawing) —
    // the dialog/page this lives in has a fixed layout width in practice.
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    canvas.getContext("2d")?.scale(ratio, ratio);

    padRef.current = new SignaturePad(canvas, { minWidth: 0.75, maxWidth: 2.2, penColor: "rgb(30,41,59)" });
    return () => {
      padRef.current?.off();
      padRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      clear: () => padRef.current?.clear(),
      isEmpty: () => padRef.current?.isEmpty() ?? true,
      toData: () => (padRef.current && !padRef.current.isEmpty() ? padRef.current.toData() : null),
    }),
    []
  );

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height }}
      className={cn("touch-none rounded-md border border-input bg-background", className)}
    />
  );
});
