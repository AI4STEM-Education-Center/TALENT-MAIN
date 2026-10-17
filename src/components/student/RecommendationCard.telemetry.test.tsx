// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresignedRecommendation } from "@/lib/exam-results";
import { RESOURCE_FLUSH_MS } from "@/lib/resource-telemetry";

// The rating footer talks to its own API/context; it's irrelevant here.
vi.mock("@/components/feedback/FeedbackRatingForm", () => ({
  FeedbackRatingForm: () => null,
}));

import { RecommendationCard } from "./RecommendationCard";

const rec: PresignedRecommendation = {
  materialId: "mat-1",
  materialTitle: "Kinematics notes",
  pageRange: { start: 4, end: 5 },
  reason: "Review motion graphs",
  pages: [
    { pageNumber: 4, imageUrl: "https://img.test/4.png" },
    { pageNumber: 5, imageUrl: "https://img.test/5.png" },
  ],
};

const SESSION_URL = "/api/student/materials/mat-1/sessions/sess-1";

let now = 1_000;
let root: Root;
let host: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;
let beacon: ReturnType<typeof vi.fn>;
/** Status codes for successive batch POSTs; 200 once exhausted. */
let batchStatuses: number[];

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  now = 1_000;
  batchStatuses = [];
  vi.spyOn(Date, "now").mockImplementation(() => now);
  fetcher = vi.fn(async (url: string) =>
    url.endsWith("/sessions")
      ? Response.json({ sessionId: "sess-1" }, { status: 201 })
      : Response.json({ ok: true }, { status: batchStatuses.shift() ?? 200 }),
  );
  vi.stubGlobal("fetch", fetcher);
  beacon = vi.fn().mockReturnValue(true);
  Object.defineProperty(navigator, "sendBeacon", {
    value: beacon,
    configurable: true,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const openButton = () =>
  host.querySelector<HTMLButtonElement>('button[aria-label^="Open"]')!;

/** Parsed bodies of the batch POSTs sent with fetch, in order. */
const batches = () =>
  fetcher.mock.calls
    .filter(([url]) => url === SESSION_URL)
    .map(([, init]) => {
      expect(init.keepalive).toBe(true);
      return JSON.parse(init.body);
    });

async function renderOpen(
  surface:
    | "results_recommendation"
    | "history_recommendation" = "results_recommendation",
) {
  await act(async () =>
    root.render(
      <RecommendationCard
        rec={rec}
        attemptId="attempt-1"
        telemetrySurface={surface}
      />,
    ),
  );
  await act(async () => openButton().click());
}

const pressEscape = () =>
  act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

const pageEvent = (type: string, persisted: boolean) => {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
};

describe("RecommendationCard engagement telemetry", () => {
  it("opens a recommended session on open and sends the final totals on close", async () => {
    await act(async () =>
      root.render(
        <RecommendationCard
          rec={rec}
          attemptId="attempt-1"
          telemetrySurface="results_recommendation"
        />,
      ),
    );
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => openButton().click());
    expect(fetcher).toHaveBeenCalledWith(
      "/api/student/materials/mat-1/sessions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      surface: "results_recommendation",
      attemptId: "attempt-1",
    });

    // A press inside the dialog counts as a click.
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    now = 3_000;
    await act(async () => {
      dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    now = 9_000;
    await pressEscape();

    const sent = batches();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ended: true, dwellMs: 8_000 });
    expect(sent[0].clickCount).toBeGreaterThanOrEqual(1);
    // jsdom has no IntersectionObserver: the first recommended page is
    // credited as the one in view.
    expect(Object.keys(sent[0].pages)).toContain("4");
    expect(beacon).not.toHaveBeenCalled();
  });

  it("resends a periodic batch the server rejected (409) on the next interval", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    await renderOpen();
    batchStatuses = [409];
    now = 5_000;
    await act(async () => {
      vi.advanceTimersByTime(RESOURCE_FLUSH_MS);
    });
    expect(batches()).toHaveLength(1);
    // Same totals (time frozen): an acknowledged batch would not be resent,
    // a rejected one must be.
    await act(async () => {
      vi.advanceTimersByTime(RESOURCE_FLUSH_MS);
    });
    const sent = batches();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    // Now acknowledged: nothing new to send.
    await act(async () => {
      vi.advanceTimersByTime(RESOURCE_FLUSH_MS);
    });
    expect(batches()).toHaveLength(2);
  });

  it("retries a rejected final batch", async () => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    await renderOpen();
    batchStatuses = [409];
    now = 4_000;
    await pressEscape();
    expect(batches()).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    const sent = batches();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[1]).toMatchObject({ ended: true, dwellMs: 3_000 });
  });

  it("falls back to sendBeacon when the keepalive request fails at the network level", async () => {
    await renderOpen();
    fetcher.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    now = 4_000;
    await pressEscape();
    expect(beacon).toHaveBeenCalledOnce();
    const [url, blob] = beacon.mock.calls[0];
    expect(url).toBe(SESSION_URL);
    expect(JSON.parse(await (blob as Blob).text())).toMatchObject({
      ended: true,
    });
  });

  it("uses sendBeacon when keepalive fetch is unavailable", async () => {
    await renderOpen();
    vi.stubGlobal("Request", undefined);
    now = 4_000;
    await pressEscape();
    expect(batches()).toHaveLength(0);
    expect(beacon).toHaveBeenCalledOnce();
  });

  it("survives a back/forward-cache round trip: pauses on persisted pagehide, resumes on pageshow", async () => {
    await renderOpen();

    // Navigating away into the bfcache: flush so far, don't finalize.
    now = 5_000;
    await act(async () => {
      window.dispatchEvent(pageEvent("pagehide", true));
    });
    expect(batches()).toHaveLength(1);
    expect(batches()[0]).toMatchObject({ ended: false, dwellMs: 4_000 });

    // Restored a minute later; the cached time is not reading time.
    now = 65_000;
    await act(async () => {
      window.dispatchEvent(pageEvent("pageshow", true));
    });
    now = 68_000;
    await pressEscape();

    const sent = batches();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ ended: true, dwellMs: 7_000 });
    // Still one session: the restore resumed it rather than opening another.
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/sessions")),
    ).toHaveLength(1);
  });

  it("finalizes on a real unload (non-persisted pagehide)", async () => {
    await renderOpen();
    now = 4_000;
    await act(async () => {
      window.dispatchEvent(pageEvent("pagehide", false));
    });
    const sent = batches();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ended: true, dwellMs: 3_000 });
  });

  it("never records the teacher's copy of the card", async () => {
    await act(async () =>
      root.render(
        <RecommendationCard
          rec={rec}
          attemptId="attempt-1"
          audience="teacher"
          telemetrySurface="results_recommendation"
        />,
      ),
    );
    await act(async () => openButton().click());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not record when the source material can't be identified", async () => {
    await act(async () =>
      root.render(
        <RecommendationCard
          rec={{ ...rec, materialId: null }}
          attemptId="attempt-1"
          telemetrySurface="results_recommendation"
        />,
      ),
    );
    await act(async () => openButton().click());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends nothing further when consent withholds a session id", async () => {
    fetcher.mockImplementation(async () => Response.json({ sessionId: null }));
    await renderOpen("history_recommendation");
    now = 5_000;
    await pressEscape();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(beacon).not.toHaveBeenCalled();
  });
});
