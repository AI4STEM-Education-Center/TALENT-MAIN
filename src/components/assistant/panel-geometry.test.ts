import { describe, expect, it } from "vitest";
import {
  clampPanelRect,
  defaultPanelRect,
  movePanelRect,
  resizePanelRect,
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  type PanelRect,
} from "./panel-geometry";

const VIEWPORT = { width: 1440, height: 900 };
const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
): PanelRect => ({
  x,
  y,
  width,
  height,
});

describe("defaultPanelRect", () => {
  it("starts where the panel used to be docked — bottom right, inside the margin", () => {
    const panel = defaultPanelRect(VIEWPORT.width, VIEWPORT.height);
    expect(panel.width).toBe(416);
    expect(panel.x + panel.width).toBe(VIEWPORT.width - 16);
    expect(panel.y + panel.height).toBe(VIEWPORT.height - 16);
  });

  it("shrinks to fit a viewport smaller than the default size", () => {
    const panel = defaultPanelRect(380, 500);
    expect(panel.width).toBe(380 - 32);
    expect(panel.height).toBe(400);
  });
});

describe("clampPanelRect", () => {
  it("pulls a panel dragged past the edge back inside", () => {
    const panel = clampPanelRect(
      rect(5000, -200, 400, 500),
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(panel.x).toBe(VIEWPORT.width - 400 - 16);
    expect(panel.y).toBe(16);
  });

  it("shrinks a stored rect that came from a larger screen", () => {
    // Otherwise the header would be off-screen and the panel unmovable.
    const panel = clampPanelRect(rect(0, 0, 1200, 1000), 800, 600);
    expect(panel.width).toBe(800 - 32);
    expect(panel.height).toBe(600 - 32);
    expect(panel.x).toBe(16);
  });

  it("never returns a panel below the usable minimum", () => {
    const panel = clampPanelRect(
      rect(100, 100, 10, 10),
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(panel.width).toBe(MIN_PANEL_WIDTH);
    expect(panel.height).toBe(MIN_PANEL_HEIGHT);
  });
});

describe("movePanelRect", () => {
  it("applies the pointer delta without changing the size", () => {
    const panel = movePanelRect(
      rect(400, 300, 416, 500),
      -120,
      40,
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(panel).toEqual(rect(280, 340, 416, 500));
  });
});

describe("resizePanelRect", () => {
  it("moves only the dragged edge", () => {
    const panel = resizePanelRect(
      rect(400, 300, 416, 400),
      "w",
      -100,
      0,
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(panel).toEqual(rect(300, 300, 516, 400));
  });

  it("grows from a corner in both axes at once", () => {
    const panel = resizePanelRect(
      rect(200, 200, 400, 300),
      "se",
      60,
      50,
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(panel).toEqual(rect(200, 200, 460, 350));
  });

  it("stops at the minimum instead of dragging the opposite edge along", () => {
    const panel = resizePanelRect(
      rect(400, 300, 416, 400),
      "w",
      900,
      0,
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(panel.width).toBe(MIN_PANEL_WIDTH);
    // The right edge stayed put: 400 + 416 = 816.
    expect(panel.x + panel.width).toBe(816);
  });

  it("keeps a resize inside the viewport", () => {
    const panel = resizePanelRect(
      rect(900, 600, 400, 260),
      "se",
      900,
      900,
      VIEWPORT.width,
      VIEWPORT.height,
    );
    expect(panel.x + panel.width).toBe(VIEWPORT.width - 16);
    expect(panel.y + panel.height).toBe(VIEWPORT.height - 16);
  });
});
