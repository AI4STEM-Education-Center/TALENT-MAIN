/**
 * Geometry for the floating assistant panel.
 *
 * Kept as pure functions over a rectangle so the drag/resize maths is testable
 * without a DOM: the component only supplies the current viewport size and the
 * pointer delta, and everything that decides where the panel may sit lives here.
 */

export type PanelRect = { x: number; y: number; width: number; height: number };

/** Which side(s) of the panel a resize drag is pulling. */
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Below this the composer and a message or two stop fitting. */
export const MIN_PANEL_WIDTH = 320;
export const MIN_PANEL_HEIGHT = 260;

/** Gap kept between the panel and the viewport edge, so it never sits flush. */
const MARGIN = 16;

/** The size the panel had before it became movable — still the starting point. */
const DEFAULT_WIDTH = 416;
const DEFAULT_MAX_HEIGHT = 640;

const STORAGE_KEY = "assistant-panel-rect";

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** The original docked position: bottom-right, 26rem wide, at most 80vh tall. */
export function defaultPanelRect(
  viewportWidth: number,
  viewportHeight: number,
): PanelRect {
  const width = Math.min(DEFAULT_WIDTH, viewportWidth - MARGIN * 2);
  const height = Math.min(
    DEFAULT_MAX_HEIGHT,
    Math.round(viewportHeight * 0.8),
    viewportHeight - MARGIN * 2,
  );
  return {
    x: viewportWidth - width - MARGIN,
    y: viewportHeight - height - MARGIN,
    width,
    height,
  };
}

/**
 * Pull a rectangle back inside the viewport. Size is clamped before position so
 * a panel that no longer fits (window shrunk, or a stored rect from a bigger
 * screen) shrinks rather than hanging off the edge with its header unreachable.
 */
export function clampPanelRect(
  rect: PanelRect,
  viewportWidth: number,
  viewportHeight: number,
): PanelRect {
  const width = clamp(
    rect.width,
    Math.min(MIN_PANEL_WIDTH, viewportWidth),
    Math.max(MIN_PANEL_WIDTH, viewportWidth - MARGIN * 2),
  );
  const height = clamp(
    rect.height,
    Math.min(MIN_PANEL_HEIGHT, viewportHeight),
    Math.max(MIN_PANEL_HEIGHT, viewportHeight - MARGIN * 2),
  );
  return {
    width,
    height,
    x: clamp(rect.x, MARGIN, Math.max(MARGIN, viewportWidth - width - MARGIN)),
    y: clamp(
      rect.y,
      MARGIN,
      Math.max(MARGIN, viewportHeight - height - MARGIN),
    ),
  };
}

/** Drag the whole panel by a pointer delta. */
export function movePanelRect(
  start: PanelRect,
  dx: number,
  dy: number,
  viewportWidth: number,
  viewportHeight: number,
): PanelRect {
  return clampPanelRect(
    { ...start, x: start.x + dx, y: start.y + dy },
    viewportWidth,
    viewportHeight,
  );
}

/**
 * Drag one edge or corner. The dragged edge stops at the minimum size instead of
 * pushing the opposite edge along, which is what keeps a resize from turning
 * into an accidental move once the panel is as small as it goes.
 */
export function resizePanelRect(
  start: PanelRect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  viewportWidth: number,
  viewportHeight: number,
): PanelRect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  if (edge.includes("w")) left = Math.min(left + dx, right - MIN_PANEL_WIDTH);
  if (edge.includes("e")) right = Math.max(right + dx, left + MIN_PANEL_WIDTH);
  if (edge.includes("n")) top = Math.min(top + dy, bottom - MIN_PANEL_HEIGHT);
  if (edge.includes("s"))
    bottom = Math.max(bottom + dy, top + MIN_PANEL_HEIGHT);

  left = Math.max(left, MARGIN);
  top = Math.max(top, MARGIN);
  right = Math.min(right, viewportWidth - MARGIN);
  bottom = Math.min(bottom, viewportHeight - MARGIN);

  return clampPanelRect(
    { x: left, y: top, width: right - left, height: bottom - top },
    viewportWidth,
    viewportHeight,
  );
}

/** A stored rect, or null when there is none / it is unreadable. */
export function readStoredPanelRect(): PanelRect | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPanelRect(parsed) ? parsed : null;
  } catch {
    // Private-mode storage, or a value another tab wrote in an older shape.
    return null;
  }
}

export function storePanelRect(rect: PanelRect): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rect));
  } catch {
    // Storage full or blocked — the panel just forgets its position.
  }
}

export function forgetPanelRect(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the caller has already reset the live rect.
  }
}

function isPanelRect(value: unknown): value is PanelRect {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (["x", "y", "width", "height"] as const).every(
    (key) =>
      typeof candidate[key] === "number" && Number.isFinite(candidate[key]),
  );
}
