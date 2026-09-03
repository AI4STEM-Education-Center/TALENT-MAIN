"use client";

/**
 * Pointer-driven move/resize for the floating assistant panel.
 *
 * The gesture deliberately runs *outside* React. The previous version called
 * `setRect` from `pointermove`, so every pointer event re-rendered the whole
 * widget — including every ReactMarkdown bubble in the transcript — and a
 * mouse firing at 500–1000Hz queued far more renders than the browser could
 * paint. The panel visibly trailed the cursor on any transcript longer than a
 * few turns.
 *
 * Here the pointer stream only records a coordinate. One `requestAnimationFrame`
 * is scheduled per burst, so the panel is written exactly once per display
 * refresh (60Hz, 120Hz, whatever the browser is actually painting at) no matter
 * how fast the pointer reports, and React renders once per *gesture* rather than
 * once per event.
 *
 * The two modes are written differently on purpose:
 *
 *   - **move** sets `transform: translate3d(...)`, which the compositor handles
 *     without layout or paint. `left`/`top` stay where React put them.
 *   - **resize** must change `width`/`height`, which is a layout, so there is no
 *     compositor-only trick available. `contain: layout paint` on the panel (see
 *     `globals.css`) is what keeps that layout from escaping into the page.
 *
 * `will-change` is set for the duration of the gesture and cleared after — left
 * on permanently it costs a compositor layer on every page that mounts the
 * widget, which is the opposite of the goal.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * `useLayoutEffect` warns when React renders on the server, and this hook is
 * reached during SSR of the dashboard shell. The layout timing only matters in
 * a browser (it exists to beat a paint), so fall back to the passive effect
 * where there are no paints to beat.
 */
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
import {
  movePanelRect,
  resizePanelRect,
  type PanelRect,
  type ResizeEdge,
} from "./panel-geometry";

export type DragMode = "move" | ResizeEdge;

type Gesture = {
  mode: DragMode;
  /** Pointer position when the gesture started; deltas are measured from it. */
  originX: number;
  originY: number;
  /** Panel geometry when the gesture started; every frame is derived from it. */
  from: PanelRect;
  /** Most recent geometry written to the DOM, and what gets committed at the end. */
  latest: PanelRect;
};

/**
 * The cursor to hold for the whole gesture. Without this the cursor flickers
 * through whatever it happens to be passing over — a text caret over the
 * transcript, a pointer over a button — because the drag is tracked on the
 * window and the pointer leaves the 6px handle immediately.
 */
const GESTURE_CURSOR: Record<DragMode, string> = {
  move: "move",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

/** Geometry for a pointer position, clamped to the viewport by the pure helpers. */
function rectForPointer(gesture: Gesture, x: number, y: number): PanelRect {
  const dx = x - gesture.originX;
  const dy = y - gesture.originY;
  const { innerWidth: vw, innerHeight: vh } = window;
  return gesture.mode === "move"
    ? movePanelRect(gesture.from, dx, dy, vw, vh)
    : resizePanelRect(gesture.from, gesture.mode, dx, dy, vw, vh);
}

/** The per-frame write: a compositor transform for a move, real box metrics otherwise. */
function paintRect(el: HTMLElement, gesture: Gesture, rect: PanelRect): void {
  if (gesture.mode === "move") {
    const dx = rect.x - gesture.from.x;
    const dy = rect.y - gesture.from.y;
    el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    return;
  }
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

/**
 * The last write of a gesture. The transform is folded back into `left`/`top`
 * in the same synchronous block that clears it, so the panel never shows a
 * frame at its pre-drag position while React catches up with the new state.
 */
function settleRect(el: HTMLElement, rect: PanelRect): void {
  el.style.transform = "";
  el.style.willChange = "";
  delete el.dataset.dragging;
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

export function usePanelDrag({
  panelRef,
  rect,
  enabled,
  onCommit,
}: {
  panelRef: React.RefObject<HTMLElement | null>;
  /** The geometry React is currently rendering; read when a gesture starts. */
  rect: PanelRect | null;
  /** False on narrow screens, where the panel is docked and cannot be dragged. */
  enabled: boolean;
  /** Called once when the gesture ends, with the geometry to persist. */
  onCommit: (rect: PanelRect) => void;
}): (mode: DragMode) => (event: React.PointerEvent) => void {
  const gestureRef = useRef<Gesture | null>(null);
  const frameRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  // `onCommit`, `enabled` and `rect` are mirrored into refs so the pointer
  // handlers — attached once per gesture — always see current values without
  // being re-subscribed mid-drag, which would drop the gesture. The mirroring
  // happens in the layout effect below rather than during render: a render
  // React discards must not be able to leave a gesture holding a callback or a
  // geometry that was never committed.
  const commitRef = useRef(onCommit);
  const enabledRef = useRef(enabled);
  const rectRef = useRef(rect);

  const paint = useCallback(() => {
    frameRef.current = null;
    const gesture = gestureRef.current;
    const point = pointerRef.current;
    const el = panelRef.current;
    if (!gesture || !point || !el) return;
    gesture.latest = rectForPointer(gesture, point.x, point.y);
    paintRect(el, gesture, gesture.latest);
  }, [panelRef]);

  const handlersRef = useRef<{ move: (e: PointerEvent) => void; end: () => void } | null>(null);

  const detach = useCallback(() => {
    const handlers = handlersRef.current;
    if (!handlers) return;
    handlersRef.current = null;
    window.removeEventListener("pointermove", handlers.move);
    window.removeEventListener("pointerup", handlers.end);
    window.removeEventListener("pointercancel", handlers.end);
  }, []);

  const end = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    detach();
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;

    // The pending frame may not have run — a pointerup can land between two
    // refreshes — so the final geometry is computed inline rather than trusting
    // whatever the last painted frame happened to be.
    const point = pointerRef.current;
    const final = point ? rectForPointer(gesture, point.x, point.y) : gesture.latest;
    pointerRef.current = null;

    document.body.style.cursor = "";
    const el = panelRef.current;
    if (el) settleRect(el, final);
    commitRef.current(final);
  }, [detach, panelRef]);

  const beginDrag = useCallback(
    (mode: DragMode) => (event: React.PointerEvent) => {
      const from = rectRef.current;
      const el = panelRef.current;
      if (!enabledRef.current || !from || !el || event.button !== 0) return;
      // Stops the browser starting a text selection or a touch scroll under the
      // gesture.
      event.preventDefault();
      // A second pointerdown without an intervening pointerup (a lost capture,
      // a second button) would otherwise leak the first gesture's listeners.
      detach();

      gestureRef.current = { mode, originX: event.clientX, originY: event.clientY, from, latest: from };
      pointerRef.current = { x: event.clientX, y: event.clientY };
      el.style.willChange = mode === "move" ? "transform" : "width, height";
      // Drives the `user-select: none` rule without a React state change, which
      // would re-render the transcript at the very moment the drag starts and
      // make the panel feel like it sticks before it moves.
      el.dataset.dragging = "true";
      document.body.style.cursor = GESTURE_CURSOR[mode];

      const move = (moveEvent: PointerEvent) => {
        pointerRef.current = { x: moveEvent.clientX, y: moveEvent.clientY };
        // Coalesces a burst of pointer events into the single frame the browser
        // is actually going to paint.
        if (frameRef.current === null) frameRef.current = requestAnimationFrame(paint);
      };
      handlersRef.current = { move, end };
      // Tracked on the window rather than the handle so a fast drag that outruns
      // the cursor keeps going instead of dropping the gesture the moment the
      // pointer leaves the 6px strip it started on.
      window.addEventListener("pointermove", move, { passive: true });
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [detach, end, paint, panelRef]
  );

  useBrowserLayoutEffect(() => {
    commitRef.current = onCommit;
    enabledRef.current = enabled;
    rectRef.current = rect;
    // A render triggered mid-gesture by something else (a streaming reply, a new
    // tool row) re-applies the stale `rect` from React state. Re-asserting the
    // live geometry here keeps the panel from snapping back for a frame.
    const gesture = gestureRef.current;
    const el = panelRef.current;
    if (gesture && el) paintRect(el, gesture, gesture.latest);
  });

  useEffect(() => detach, [detach]);

  return beginDrag;
}
