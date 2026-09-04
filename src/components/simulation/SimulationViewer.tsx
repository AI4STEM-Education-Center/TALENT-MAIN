"use client";

import { useEffect, useRef } from "react";
import {
  SIM_TELEMETRY_MESSAGE_TYPE,
  type SimulationSurface,
  type SimTelemetryTotals,
} from "@/lib/simulation-telemetry";

/** Flush accumulated telemetry to the API this often while the viewer is open. */
const FLUSH_MS = 10_000;

export type SimulationTelemetryContext = {
  /** The quiz attempt whose results page surfaced this simulation. */
  attemptId?: string | null;
  surface: SimulationSurface;
};

/**
 * Sandboxed renderer for a simulation's HTML artifact. The document is served
 * by /api/simulations/[id]/content with a strict CSP; the sandbox attribute
 * (scripts only — no same-origin, forms, popups, or navigation) is the second
 * layer keeping AI-generated JS away from the app origin. Shared by the admin
 * dashboard, the teacher editor, and the student results view.
 *
 * When `telemetry` is passed (student results view only), the viewer opens a
 * SimulationSession and forwards the cumulative interaction totals that the
 * served document's injected script postMessages up — the sandboxed iframe has
 * no network access of its own. Messages are accepted only from this viewer's
 * own iframe (sandboxed frames have an opaque origin, so source-matching is
 * the correct check). Batches flush periodically and on close, the final one
 * via sendBeacon so it survives navigation.
 */
export function SimulationViewer({
  simulationId,
  title,
  version,
  telemetry,
  selectedVersion,
  onTextEdit,
}: {
  simulationId: string;
  title: string;
  /** Bump to bust the browser's private cache after a revision lands. */
  version?: number;
  telemetry?: SimulationTelemetryContext;
  selectedVersion?: number;
  onTextEdit?: (before: string, after: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (!onTextEdit) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        event.data?.type !== "simulation-text-edit"
      )
        return;
      if (
        typeof event.data.before === "string" &&
        typeof event.data.after === "string" &&
        event.data.before.length <= 2000 &&
        event.data.after.length <= 2000
      )
        onTextEdit(event.data.before, event.data.after);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onTextEdit]);
  const attemptId = telemetry?.attemptId ?? null;
  const surface = telemetry?.surface ?? null;

  useEffect(() => {
    if (!surface) return;
    const startedAt = Date.now();
    let sessionId: string | null = null;
    let cancelled = false;
    let dirty = false;
    let finalSent = false;
    let totals: SimTelemetryTotals = {
      activeMs: 0,
      interactionCount: 0,
      paramChanges: 0,
      controls: {},
    };

    fetch(`/api/simulations/${simulationId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId, surface }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && typeof data?.sessionId === "string")
          sessionId = data.sessionId;
      })
      .catch(() => {
        // Telemetry is best-effort — the simulation itself is unaffected.
      });

    const onMessage = (event: MessageEvent) => {
      if (
        !iframeRef.current ||
        event.source !== iframeRef.current.contentWindow
      )
        return;
      const data = event.data as Partial<SimTelemetryTotals> & {
        type?: string;
      };
      if (!data || data.type !== SIM_TELEMETRY_MESSAGE_TYPE) return;
      totals = {
        activeMs:
          typeof data.activeMs === "number" ? data.activeMs : totals.activeMs,
        interactionCount:
          typeof data.interactionCount === "number"
            ? data.interactionCount
            : totals.interactionCount,
        paramChanges:
          typeof data.paramChanges === "number"
            ? data.paramChanges
            : totals.paramChanges,
        controls:
          data.controls && typeof data.controls === "object"
            ? data.controls
            : totals.controls,
      };
      dirty = true;
    };
    window.addEventListener("message", onMessage);

    const flush = (ended: boolean) => {
      if (!sessionId || finalSent || (!dirty && !ended)) return;
      dirty = false;
      if (ended) finalSent = true;
      const url = `/api/simulations/${simulationId}/sessions/${sessionId}`;
      const body = JSON.stringify({
        ...totals,
        dwellMs: Date.now() - startedAt,
        ended,
      });
      if (ended && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(
          url,
          new Blob([body], { type: "application/json" }),
        );
      } else {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    };

    const interval = setInterval(() => flush(false), FLUSH_MS);
    const onPageHide = () => flush(true);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", onPageHide);
      flush(true);
    };
  }, [simulationId, attemptId, surface]);

  return (
    <iframe
      ref={iframeRef}
      src={`/api/simulations/${simulationId}/content?v=${version ?? 0}${selectedVersion ? `&version=${selectedVersion}` : ""}${onTextEdit ? "&edit=1" : ""}`}
      title={title}
      sandbox="allow-scripts"
      className="h-full w-full rounded-md border bg-white"
    />
  );
}
