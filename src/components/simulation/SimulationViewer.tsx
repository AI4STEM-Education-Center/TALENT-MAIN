"use client";

import { useEffect, useRef } from "react";
import {
  readPreviewEdit,
  type SimulationPreviewEdit,
} from "@/lib/simulation-preview-edit";
import {
  SIM_ESCAPE_MESSAGE_TYPE,
  SIM_TELEMETRY_MESSAGE_TYPE,
  classifyViewport,
  type SimulationSurface,
  type SimTelemetryTotals,
} from "@/lib/simulation-telemetry";

/** Flush accumulated telemetry to the API this often while the viewer is open. */
const FLUSH_MS = 10_000;

export type SimulationTelemetryContext = {
  /** The quiz attempt whose results page surfaced this simulation. */
  attemptId?: string | null;
  /** Where the student launched it from — see SIMULATION_SURFACES. */
  surface: SimulationSurface;
};

/**
 * Sandboxed renderer for a simulation's HTML artifact. The document is served
 * by /api/simulations/[id]/content with a strict CSP; the sandbox attribute
 * (scripts only — no same-origin, forms, popups, or navigation) is the second
 * layer keeping AI-generated JS away from the app origin. Shared by the admin
 * dashboard, the teacher editor, and the student results view.
 *
 * When `telemetry` is passed (student launches only, via SimulationDialog), the viewer opens a
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
  editable,
  editMode,
  onPreviewEdit,
  onEscape,
}: {
  simulationId: string;
  title: string;
  /** Bump to bust the browser's private cache after a revision lands. */
  version?: number;
  telemetry?: SimulationTelemetryContext;
  selectedVersion?: number;
  /**
   * Serve the in-preview editing layer. Deliberately separate from the
   * callbacks below: it is part of the iframe's `src`, so deriving it from a
   * handler that comes and goes with a request in flight would reload — and
   * restart — the simulation around every chat message.
   */
  editable?: boolean;
  /**
   * Whether the injected layer is armed. Toggled by message rather than by the
   * `src`, so entering edit mode does not reload — and restart — the running
   * simulation.
   */
  editMode?: boolean;
  onPreviewEdit?: (edit: SimulationPreviewEdit) => void;
  /** Escape pressed while focus is inside the simulation (forwarded up). */
  onEscape?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Held in a ref so a new inline handler on every parent render does not tear
  // down and re-add the listener. Only ever read from a user-driven message,
  // which cannot arrive before the commit that refreshed it.
  const handlers = useRef({ onPreviewEdit, onEscape });
  useEffect(() => {
    handlers.current = { onPreviewEdit, onEscape };
  });
  useEffect(() => {
    if (!editable) return;
    const receive = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const edit = readPreviewEdit(event.data);
      if (!edit) return;
      const ticket = (event.data as { ticket?: unknown }).ticket;
      handlers.current.onPreviewEdit?.({
        ...edit,
        // The sandbox has no KaTeX, so a committed formula stays as its source
        // until the parent renders it and paints the result back.
        paint: (html, latex) =>
          frame.contentWindow?.postMessage(
            { type: "sim-formula-painted", ticket, html, latex },
            "*",
          ),
      });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [editable]);
  useEffect(() => {
    if (!editable) return;
    const frame = iframeRef.current;
    const send = () =>
      frame?.contentWindow?.postMessage(
        { type: "sim-edit-mode", on: !!editMode },
        "*",
      );
    send();
    // The document may still be loading the first time this runs.
    frame?.addEventListener("load", send);
    return () => frame?.removeEventListener("load", send);
  }, [editable, editMode]);
  const attemptId = telemetry?.attemptId ?? null;
  const surface = telemetry?.surface ?? null;

  // One session per mount: SimulationDialog mounts a fresh viewer on every
  // open (and on every switch between simulations), so each launch is its own
  // SimulationSession and closing the dialog runs the cleanup's final flush.
  useEffect(() => {
    if (!surface) return;
    const startedAt = Date.now();
    const viewport = classifyViewport(window.innerWidth);
    let sessionId: string | null = null;
    let cancelled = false;
    let dirty = false;
    let finalSent = false;
    let endedAt: number | null = null;
    let totals: SimTelemetryTotals = {
      activeMs: 0,
      interactionCount: 0,
      paramChanges: 0,
      controls: {},
    };

    // Deferred by a macrotask so React Strict Mode's synchronous
    // mount → cleanup → mount in development cancels the first create instead
    // of recording two sessions for one open.
    const openTimer = setTimeout(() => {
      fetch(`/api/simulations/${simulationId}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId, surface, viewport }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (typeof data?.sessionId === "string") {
            sessionId = data.sessionId;
            if (cancelled || endedAt !== null) flush(true);
          }
        })
        .catch(() => {
          // Telemetry is best-effort — the simulation itself is unaffected.
        });
    }, 0);

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
        dwellMs: (endedAt ?? Date.now()) - startedAt,
        ended,
      });
      if (ended && typeof navigator.sendBeacon === "function") {
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

    const interval = setInterval(() => flush(false), FLUSH_MS);
    const onPageHide = () => {
      endedAt ??= Date.now();
      flush(true);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      cancelled = true;
      clearTimeout(openTimer);
      clearInterval(interval);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pagehide", onPageHide);
      onPageHide();
    };
  }, [simulationId, attemptId, surface]);

  // Escape pressed inside the sandboxed document never reaches the parent's
  // key handlers (separate browsing context), so the injected forwarder posts
  // it up; only messages from this viewer's own iframe are honoured.
  const hasEscapeHandler = !!onEscape;
  useEffect(() => {
    if (!hasEscapeHandler) return;
    const receive = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (
        (event.data as { type?: unknown } | null)?.type !==
        SIM_ESCAPE_MESSAGE_TYPE
      )
        return;
      handlers.current.onEscape?.();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [hasEscapeHandler]);

  return (
    <iframe
      ref={iframeRef}
      src={`/api/simulations/${simulationId}/content?v=${version ?? 0}${selectedVersion ? `&version=${selectedVersion}` : ""}${editable ? "&edit=1" : ""}`}
      title={title}
      sandbox="allow-scripts"
      className="h-full w-full rounded-md border bg-white"
    />
  );
}
