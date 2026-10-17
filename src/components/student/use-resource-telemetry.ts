"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RESOURCE_FLUSH_MS,
  ResourceTelemetryTracker,
  type ResourceSurface,
  type ResourceTotals,
} from "@/lib/resource-telemetry";

/** Consecutive failed periodic batches before periodic sends stop. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Attempts (incl. the first) for the final batch, with linear backoff. */
const MAX_FINAL_ATTEMPTS = 3;
const FINAL_RETRY_MS = 1_000;

/** keepalive fetch: Chromium/Safari, Firefox 133+. */
function keepaliveSupported(): boolean {
  return typeof Request !== "undefined" && "keepalive" in Request.prototype;
}

export type ResourceTelemetryOptions = {
  /**
   * Record while true: the viewer is open AND this is the student's own view.
   * Flipping to false (dialog closed, unmount) ends the session.
   */
  enabled: boolean;
  /** The material being read; null (unidentifiable) disables tracking. */
  materialId: string | null | undefined;
  surface: ResourceSurface;
  /** The results page's attempt, for recommendation surfaces. */
  attemptId?: string | null;
};

export type ResourceTelemetryHandle = {
  /** Attach to the viewer's root element; presses inside it count as clicks. */
  containerRef: (element: HTMLElement | null) => void;
  /** Report the page currently in view (null when none is). */
  viewPage: (page: number | null) => void;
  /** Report that the original PDF was opened from the viewer. */
  notePdfOpen: () => void;
};

/**
 * Engagement telemetry for one open of a learning material, mirroring
 * SimulationViewer's session lifecycle:
 *
 * 1. On enable, POST /api/student/materials/[id]/sessions. A non-consenting
 *    student (or an unverifiable open) gets no sessionId and nothing is ever
 *    sent after that — the tracker still runs locally but goes nowhere.
 * 2. While open, a ResourceTelemetryTracker accumulates dwell (paused while
 *    the tab is hidden), active time, presses inside the viewer, and per-page
 *    time. Cumulative totals flush every RESOURCE_FLUSH_MS when they differ
 *    from what the server last acknowledged, and whenever the tab is hidden
 *    (mobile browsers may never fire pagehide). A rejected batch (409, 5xx,
 *    network) stays pending and is resent on the next tick.
 * 3. On disable/unmount/unloading pagehide the final batch goes out via
 *    keepalive fetch (retried on rejection; sendBeacon only when keepalive
 *    is unavailable or the request fails at the network level), frozen at
 *    the moment of closing — even if the session id only arrives afterwards.
 *    A pagehide into the back/forward cache only pauses and flushes;
 *    pageshow resumes the same session.
 *
 * Best-effort throughout: failures never surface to the reader.
 */
export function useResourceTelemetry({
  enabled,
  materialId,
  surface,
  attemptId = null,
}: ResourceTelemetryOptions): ResourceTelemetryHandle {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const trackerRef = useRef<ResourceTelemetryTracker | null>(null);
  // The page in view can be reported before the session effect runs (or
  // between sessions); replay it into each new tracker.
  const pageRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !materialId) return;
    const tracker = new ResourceTelemetryTracker(
      Date.now(),
      document.visibilityState !== "hidden",
    );
    if (pageRef.current !== null) tracker.viewPage(pageRef.current, Date.now());
    trackerRef.current = tracker;

    let sessionId: string | null = null;
    let finalTotals: ResourceTotals | null = null;
    // The final batch has been handed to the network (it retries itself).
    let finalSent = false;
    // Totals the server last ACKNOWLEDGED. Only a 2xx advances it, so a
    // rejected or failed periodic batch stays pending and goes out again on
    // the next tick (totals are cumulative, so resending is idempotent).
    let delivered = "";
    let inFlight = 0;
    let failures = 0;
    const base = `/api/student/materials/${encodeURIComponent(materialId)}/sessions`;

    const beacon = (url: string, body: string): boolean =>
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));

    /**
     * POST one batch; resolves true when it was delivered. keepalive fetch
     * first — it survives page teardown like a beacon but reports the
     * response, so failures can be retried. sendBeacon (fire-and-forget,
     * counted as delivered when queued) only when keepalive is unavailable or
     * the fetch itself fails at the network level.
     */
    const post = (body: string): Promise<boolean> => {
      const url = `${base}/${encodeURIComponent(sessionId!)}`;
      if (!keepaliveSupported()) return Promise.resolve(beacon(url, body));
      try {
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).then(
          (res) => res.ok,
          () => beacon(url, body),
        );
      } catch {
        return Promise.resolve(beacon(url, body));
      }
    };

    const sendFinal = (body: string, attempt: number) => {
      void post(body).then((ok) => {
        if (!ok && attempt + 1 < MAX_FINAL_ATTEMPTS) {
          setTimeout(
            () => sendFinal(body, attempt + 1),
            FINAL_RETRY_MS * (attempt + 1),
          );
        }
      });
    };

    /**
     * `urgent` (tab hidden / page entering the bfcache) sends even while a
     * periodic batch is in flight — the page may not get another chance.
     */
    const flush = (ended: boolean, urgent = false) => {
      if (finalSent) return;
      const totals = finalTotals ?? tracker.snapshot(Date.now());
      if (!sessionId) return;
      if (ended) {
        finalSent = true;
        sendFinal(JSON.stringify({ ...totals, ended: true }), 0);
        return;
      }
      // One periodic batch at a time; after repeated consecutive failures,
      // stop periodic sends (the final batch is still attempted).
      if ((inFlight > 0 && !urgent) || failures >= MAX_CONSECUTIVE_FAILURES)
        return;
      const payload = JSON.stringify(totals);
      if (payload === delivered) return;
      inFlight += 1;
      void post(JSON.stringify({ ...totals, ended: false })).then((ok) => {
        inFlight -= 1;
        if (ok) {
          delivered = payload;
          failures = 0;
        } else {
          failures += 1;
        }
      });
    };

    const close = () => {
      finalTotals ??= tracker.snapshot(Date.now());
      flush(true);
    };

    fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surface, attemptId }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (typeof data?.sessionId !== "string") return;
        sessionId = data.sessionId;
        // Closed before the id arrived: send the frozen final batch now.
        if (finalTotals) flush(true);
      })
      .catch(() => {
        // Telemetry is best-effort — reading is unaffected.
      });

    const interval = setInterval(() => flush(false), RESOURCE_FLUSH_MS);
    const onVisibility = () => {
      const visible = document.visibilityState !== "hidden";
      tracker.setVisible(visible, Date.now());
      if (!visible) flush(false, true);
    };
    // A pagehide into the back/forward cache (persisted) is not the end of the
    // read: the page — and this session — may come back. Pause and flush the
    // totals so far, and resume on pageshow. Only a real unload finalizes.
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        close();
        return;
      }
      tracker.setVisible(false, Date.now());
      flush(false, true);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      tracker.setVisible(document.visibilityState !== "hidden", Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      if (trackerRef.current === tracker) trackerRef.current = null;
      close();
    };
  }, [enabled, materialId, surface, attemptId]);

  // DOM listeners read the tracker at event time, so they don't depend on
  // (or race) the session effect above.
  useEffect(() => {
    if (!container) return;
    const onPress = () => trackerRef.current?.click(Date.now());
    const onActivity = () => trackerRef.current?.activity(Date.now());
    const opts = { capture: true, passive: true } as const;
    container.addEventListener("pointerdown", onPress, opts);
    container.addEventListener("keydown", onPress, opts);
    // scroll doesn't bubble; capture sees scrolls of any inner pane.
    container.addEventListener("scroll", onActivity, opts);
    container.addEventListener("wheel", onActivity, opts);
    container.addEventListener("pointermove", onActivity, opts);
    container.addEventListener("touchmove", onActivity, opts);
    return () => {
      container.removeEventListener("pointerdown", onPress, opts);
      container.removeEventListener("keydown", onPress, opts);
      container.removeEventListener("scroll", onActivity, opts);
      container.removeEventListener("wheel", onActivity, opts);
      container.removeEventListener("pointermove", onActivity, opts);
      container.removeEventListener("touchmove", onActivity, opts);
    };
  }, [container]);

  const viewPage = useCallback((page: number | null) => {
    pageRef.current = page;
    trackerRef.current?.viewPage(page, Date.now());
  }, []);

  const notePdfOpen = useCallback(() => {
    trackerRef.current?.pdfOpened(Date.now());
  }, []);

  return { containerRef: setContainer, viewPage, notePdfOpen };
}
