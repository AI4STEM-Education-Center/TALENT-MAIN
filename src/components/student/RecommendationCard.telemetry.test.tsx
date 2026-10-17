// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresignedRecommendation } from "@/lib/exam-results";

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

let now = 1_000;
let root: Root;
let host: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;
let beacon: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  fetcher = vi.fn(async (url: string) =>
    url.endsWith("/sessions")
      ? Response.json({ sessionId: "sess-1" }, { status: 201 })
      : Response.json({ ok: true }),
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const openButton = () =>
  host.querySelector<HTMLButtonElement>('button[aria-label^="Open"]')!;

async function blobJson(blob: Blob) {
  return JSON.parse(await blob.text());
}

describe("RecommendationCard engagement telemetry", () => {
  it("opens a recommended session on open and beacons the final totals on close", async () => {
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
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(beacon).toHaveBeenCalledOnce();
    const [url, blob] = beacon.mock.calls[0];
    expect(url).toBe("/api/student/materials/mat-1/sessions/sess-1");
    const body = await blobJson(blob);
    expect(body).toMatchObject({ ended: true, dwellMs: 8_000 });
    expect(body.clickCount).toBeGreaterThanOrEqual(1);
    // jsdom has no IntersectionObserver: the first recommended page is
    // credited as the one in view.
    expect(Object.keys(body.pages)).toContain("4");
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
    await act(async () =>
      root.render(
        <RecommendationCard
          rec={rec}
          attemptId="attempt-1"
          telemetrySurface="history_recommendation"
        />,
      ),
    );
    await act(async () => openButton().click());
    now = 5_000;
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(beacon).not.toHaveBeenCalled();
  });
});
