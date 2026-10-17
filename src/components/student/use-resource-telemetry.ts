"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RESOURCE_FLUSH_MS,
  ResourceTelemetryTracker,
  type ResourceSurface,
  type ResourceTotals,
} from "@/lib/resource-telemetry";

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
 *    time. Cumulative totals flush every RESOURCE_FLUSH_MS when changed, and
 *    whenever the tab is hidden (mobile browsers may never fire pagehide).
 * 3. On disable/unmount/unloading pagehide the final batch goes out via
 *    sendBeacon (falling back to keepalive fetch), frozen at the moment of closing — even
 *    if the session id only arrives afterwards. A pagehide into the
 *    back/forward cache only pauses and flushes; pageshow resumes the same
 *    session.
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
    let finalSent = false;
    let lastSent = "";
    const base = `/api/student/materials/${encodeURIComponent(materialId)}/sessions`;

    const send = (body: string, beacon: boolean) => {
      const url = `${base}/${encodeURIComponent(sessionId!)}`;
      if (beacon && typeof navigator.sendBeacon === "function") {
        const queued = navigator.sendBeacon(
          url,
          new Blob([body], { type: "application/json" }),
        );
        if (queued) return;
      }
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    };

    const flush = (ended: boolean, beacon = ended) => {
      if (finalSent) return;
      const totals = finalTotals ?? tracker.snapshot(Date.now());
      if (!sessionId) return;
      const payload = JSON.stringify(totals);
      if (!ended && payload === lastSent) return;
      lastSent = payload;
      if (ended) finalSent = true;
      send(JSON.stringify({ ...totals, ended }), beacon);
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
