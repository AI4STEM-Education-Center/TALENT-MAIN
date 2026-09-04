// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantWidget } from "./AssistantWidget";
import { AssistantLauncher } from "./AssistantLauncher";
import { AssistantProvider } from "./assistant-context";
import { formatBytes, MAX_IMAGE_EDGE } from "./attachment-input";

describe("AssistantWidget", () => {
  it("renders nothing until /api/assistant/config says an assistant is available", () => {
    // The panel must not flash for admins or signed-out users, so the pre-fetch
    // render has to be empty rather than a hidden-but-present dialog.
    expect(
      renderToStaticMarkup(
        <AssistantProvider>
          <AssistantWidget />
        </AssistantProvider>,
      ),
    ).toBe("");
  });
});

describe("AssistantLauncher", () => {
  it("renders no sidebar row until an assistant is available", () => {
    // Same reason as the panel: the rail keeps its previous shape for roles
    // that have no assistant, rather than showing a button that opens nothing.
    expect(
      renderToStaticMarkup(
        <AssistantProvider>
          <AssistantLauncher />
        </AssistantProvider>,
      ),
    ).toBe("");
  });
});

// ─── Drag and resize ─────────────────────────────────────────────────────────

/**
 * Mount the real panel, opened, on a viewport wide enough to float. jsdom has
 * no matchMedia result other than `false` and no PointerEvent, so both are
 * stubbed — everything else is the component as it ships.
 */
async function mountOpenPanel(): Promise<{
  panel: HTMLElement;
  cleanup: () => void;
}> {
  // React only suppresses its "not wrapped in act(...)" warning when this is set.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        available: true,
        audience: "student",
        greeting: "Hi",
        attachmentKinds: [],
        maxAttachments: 0,
        maxAttachmentBytes: 0,
      }),
    })),
  );
  // jsdom does not implement scrolling; the transcript auto-scroll calls it.
  Element.prototype.scrollTo = () => {};
  window.localStorage.clear();

  const host = document.createElement("div");
  document.body.append(host);
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(
      <AssistantProvider>
        <AssistantLauncher />
        <AssistantWidget />
      </AssistantProvider>,
    );
  });

  const launcher = host.querySelector<HTMLButtonElement>(
    "button[aria-label^='Open']",
  );
  if (!launcher) throw new Error("the launcher never appeared");
  await act(async () => launcher.click());

  const panel = host.querySelector<HTMLElement>("[role='dialog']");
  if (!panel) throw new Error("the panel never opened");
  return {
    panel,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    },
  };
}

/** jsdom has no PointerEvent; React only reads the mouse-event fields. */
function pointer(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
}

async function drag(
  target: EventTarget,
  from: [number, number],
  to: [number, number],
) {
  await act(async () =>
    target.dispatchEvent(pointer("pointerdown", from[0], from[1])),
  );
  await act(async () =>
    window.dispatchEvent(pointer("pointermove", to[0], to[1])),
  );
  await act(async () =>
    window.dispatchEvent(pointer("pointerup", to[0], to[1])),
  );
}

describe("moving and resizing the panel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows a drag on the header and keeps the size", async () => {
    const { panel, cleanup } = await mountOpenPanel();
    try {
      const header = panel.querySelector("header");
      expect(header).not.toBeNull();
      const before = {
        left: panel.style.left,
        top: panel.style.top,
        width: panel.style.width,
      };

      // Up and to the left: the panel opens against the bottom-right margin, so
      // that is the only direction with room to move on a 1024x768 jsdom window.
      await drag(header!, [500, 200], [400, 80]);

      expect(parseFloat(panel.style.left)).toBe(parseFloat(before.left) - 100);
      expect(parseFloat(panel.style.top)).toBe(parseFloat(before.top) - 120);
      // A move is not a resize.
      expect(panel.style.width).toBe(before.width);
    } finally {
      cleanup();
    }
  });

  it("will not let a drag push the panel off the screen", async () => {
    const { panel, cleanup } = await mountOpenPanel();
    try {
      const header = panel.querySelector("header");
      await drag(header!, [500, 200], [-4000, -4000]);
      // Pinned to the margin rather than dragged out of reach.
      expect(parseFloat(panel.style.left)).toBe(16);
      expect(parseFloat(panel.style.top)).toBe(16);
    } finally {
      cleanup();
    }
  });

  it("moves on the compositor and only touches layout once, at the end", async () => {
    // The perf contract for a move drag: while the gesture runs the panel is
    // offset with a transform (no layout, no React render), and `left`/`top`
    // are written exactly once — when the gesture ends. A regression here means
    // the panel is back to laying out the page on every pointer event.
    const { panel, cleanup } = await mountOpenPanel();
    try {
      const header = panel.querySelector("header")!;
      const left = parseFloat(panel.style.left);
      const top = parseFloat(panel.style.top);

      await act(async () =>
        header.dispatchEvent(pointer("pointerdown", 500, 200)),
      );
      await act(async () =>
        window.dispatchEvent(pointer("pointermove", 460, 150)),
      );
      // Let the scheduled frame run.
      await act(
        async () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );

      expect(panel.style.transform).toBe("translate3d(-40px, -50px, 0)");
      // Untouched mid-gesture — the transform is doing the moving.
      expect(parseFloat(panel.style.left)).toBe(left);
      expect(parseFloat(panel.style.top)).toBe(top);

      await act(async () =>
        window.dispatchEvent(pointer("pointerup", 460, 150)),
      );

      // Folded back into real geometry, and the transform cleared in the same
      // breath so the panel never flashes at its old position.
      expect(panel.style.transform).toBe("");
      expect(parseFloat(panel.style.left)).toBe(left - 40);
      expect(parseFloat(panel.style.top)).toBe(top - 50);
      // Not left promoted after the gesture — a permanent compositor layer is a
      // cost paid on every page that mounts the widget.
      expect(panel.style.willChange).toBe("");
    } finally {
      cleanup();
    }
  });

  it("coalesces a burst of pointer moves into a single frame", async () => {
    // A mouse can report at 1000Hz. The panel must still be written once per
    // display refresh, not once per event — this is the difference between a
    // smooth drag and the queue-of-renders the old version built.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const { panel, cleanup } = await mountOpenPanel();
    try {
      const header = panel.querySelector("header")!;
      await act(async () =>
        header.dispatchEvent(pointer("pointerdown", 500, 200)),
      );
      for (let i = 0; i < 25; i++) {
        await act(async () =>
          window.dispatchEvent(pointer("pointermove", 500 - i, 200 - i)),
        );
      }

      expect(frames).toHaveLength(1);

      // The one frame that does run paints the LAST position, not the first —
      // coalescing must not mean lagging behind the pointer.
      await act(async () => frames[0](0));
      expect(panel.style.transform).toBe("translate3d(-24px, -24px, 0)");
    } finally {
      cleanup();
    }
  });

  it("grows when the west edge is dragged outward, and remembers the result", async () => {
    const { panel, cleanup } = await mountOpenPanel();
    try {
      const width = parseFloat(panel.style.width);
      const left = parseFloat(panel.style.left);
      // The west strip runs down the panel's left border.
      const handle = panel.querySelector(".cursor-ew-resize");
      expect(handle).not.toBeNull();

      await drag(handle!, [left, 400], [left - 90, 400]);

      expect(parseFloat(panel.style.width)).toBe(width + 90);
      expect(parseFloat(panel.style.left)).toBe(left - 90);
      // Persisted once the gesture ends, so the panel reopens where it was left.
      expect(
        JSON.parse(window.localStorage.getItem("assistant-panel-rect") ?? "{}"),
      ).toMatchObject({ width: width + 90 });
    } finally {
      cleanup();
    }
  });
});

describe("formatBytes", () => {
  it("scales the unit with the size", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
  });
});

describe("MAX_IMAGE_EDGE", () => {
  it("stays within what vision models actually consume", () => {
    expect(MAX_IMAGE_EDGE).toBeLessThanOrEqual(2048);
  });
});
