// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationsBadge } from "./notifications-badge";

afterEach(() => vi.unstubAllGlobals());
it("ignores a stale unread count after a newer refresh, and aborts on unmount", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const pending: {
    resolve: (response: Response) => void;
    signal: AbortSignal;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options) =>
        new Promise<Response>((resolve) =>
          pending.push({ resolve, signal: options.signal }),
        ),
    ),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<NotificationsBadge />));
    await act(async () =>
      window.dispatchEvent(new Event("notifications:updated")),
    );
    expect(pending[0].signal.aborted).toBe(true);
    await act(async () =>
      pending[1].resolve(Response.json({ unreadCount: 2 })),
    );
    await act(async () =>
      pending[0].resolve(Response.json({ unreadCount: 8 })),
    );
    expect(container.textContent).toBe("2");
  } finally {
    await act(async () => root.unmount());
  }
  expect(pending[1].signal.aborted).toBe(true);
});
