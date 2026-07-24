// Pure helpers for simulation interaction telemetry: the auto-instrumentation
// script injected into served artifacts, the postMessage protocol it shares
// with SimulationViewer, and the sanitizers/merge rules for the client-reported
// counters. Everything here is pure (no DB / Next imports) so it can be
// unit-tested like `simulation.ts`; the routes and the serving injection live
// under /api/simulations.
//
// How data escapes the sandbox: the artifact iframe has no network access (CSP
// default-src 'none', sandbox without allow-same-origin), but postMessage to
// the parent works. The injected script counts generic interactions inside the
// document and posts cumulative totals to the parent every few seconds; the
// parent (SimulationViewer) owns the session lifecycle and forwards batches to
// the API. All of it is client-reported engagement signal, not ground truth —
// the server clamps everything.

/** postMessage `type` the injected script uses for its cumulative batches. */
export const SIM_TELEMETRY_MESSAGE_TYPE = "sim-telemetry";

/** Where the student was viewing the simulation. */
export type SimulationSurface = "rail" | "mobile";

/** Cumulative in-simulation totals reported by the injected script. */
export type SimTelemetryTotals = {
  activeMs: number;
  interactionCount: number;
  paramChanges: number;
  controls: Record<string, number>;
};

// Server-side clamps. Sessions longer than a school day or with millions of
// clicks are client fabrication; clamping (rather than rejecting) keeps honest
// sessions flowing even when a counter overflows its cap.
export const MAX_TELEMETRY_MS = 4 * 60 * 60 * 1000; // 4h
export const MAX_TELEMETRY_COUNT = 100_000;
export const MAX_TELEMETRY_CONTROLS = 40;
export const MAX_CONTROL_LABEL_CHARS = 80;

/**
 * The auto-instrumentation script injected (for students) when an artifact is
 * served. Generic by design — it knows nothing about the specific simulation:
 * it counts pointer/key interactions, control (slider/select/…) changes keyed
 * by the control's visible label, and "active" time (any activity within the
 * last 5s), then posts the cumulative totals to the parent every 2s. It must
 * stay dependency-free and use NO network APIs (the CSP blocks them; the
 * parent does the reporting).
 */
export const SIMULATION_TELEMETRY_SNIPPET = `<script>
(function () {
  if (window.__simTelemetryInstalled) return;
  window.__simTelemetryInstalled = true;
  var activeMs = 0, interactionCount = 0, paramChanges = 0;
  var controls = {};
  var lastActivity = 0;
  var lastTick = Date.now();
  function markActive() { lastActivity = Date.now(); }
  function labelFor(el) {
    try {
      var lbl = el.getAttribute && (el.getAttribute("aria-label") || el.name || el.id);
      if (!lbl && el.labels && el.labels.length) lbl = el.labels[0].textContent;
      if (!lbl && el.closest) {
        var wrap = el.closest("label");
        if (wrap) lbl = wrap.textContent;
      }
      lbl = String(lbl || el.tagName || "control").replace(/\\s+/g, " ").trim().slice(0, ${MAX_CONTROL_LABEL_CHARS});
      return lbl || "control";
    } catch (e) { return "control"; }
  }
  document.addEventListener("pointerdown", function () { interactionCount++; markActive(); }, true);
  document.addEventListener("keydown", function () { interactionCount++; markActive(); }, true);
  document.addEventListener("pointermove", markActive, true);
  document.addEventListener("input", function (e) {
    paramChanges++; markActive();
    var key = labelFor(e.target);
    if (Object.prototype.hasOwnProperty.call(controls, key) || Object.keys(controls).length < ${MAX_TELEMETRY_CONTROLS}) {
      controls[key] = (controls[key] || 0) + 1;
    }
  }, true);
  setInterval(function () {
    var now = Date.now();
    if (now - lastActivity < 5000) activeMs += now - lastTick;
    lastTick = now;
    try {
      parent.postMessage({
        type: "${SIM_TELEMETRY_MESSAGE_TYPE}",
        activeMs: activeMs,
        interactionCount: interactionCount,
        paramChanges: paramChanges,
        controls: controls
      }, "*");
    } catch (e) {}
  }, 2000);
})();
</script>`;

/**
 * Insert the telemetry snippet into a served artifact, just before </body>
 * (falling back to before </html>, then to appending). Serve-time injection —
 * the stored artifact is never modified, and artifacts generated before
 * telemetry existed report exactly like new ones.
 */
export function injectTelemetryScript(html: string): string {
  const lower = html.toLowerCase();
  for (const closer of ["</body>", "</html>"]) {
    const idx = lower.lastIndexOf(closer);
    if (idx !== -1) return html.slice(0, idx) + SIMULATION_TELEMETRY_SNIPPET + html.slice(idx);
  }
  return html + SIMULATION_TELEMETRY_SNIPPET;
}

const clampCount = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), max) : 0;

/** Clamp a client-reported millisecond duration into [0, MAX_TELEMETRY_MS]. */
export const clampTelemetryMs = (value: number): number => clampCount(value, MAX_TELEMETRY_MS);

/** Clamp a client-reported counter into [0, MAX_TELEMETRY_COUNT]. */
export const clampTelemetryCount = (value: number): number =>
  clampCount(value, MAX_TELEMETRY_COUNT);

/**
 * Sanitize a client-reported {controlLabel: changeCount} map: normalize and
 * truncate labels, drop empties and non-positive counts, clamp counts, and cap
 * the entry count (keeping the most-changed controls so the cap can't be used
 * to crowd out the real signal).
 */
export function sanitizeControlCounts(input: Record<string, number>): Record<string, number> {
  const merged = new Map<string, number>();
  for (const [rawKey, rawCount] of Object.entries(input)) {
    const key = rawKey.replace(/\s+/g, " ").trim().slice(0, MAX_CONTROL_LABEL_CHARS);
    const count = clampTelemetryCount(rawCount);
    if (!key || count <= 0) continue;
    merged.set(key, Math.min((merged.get(key) ?? 0) + count, MAX_TELEMETRY_COUNT));
  }
  const kept = [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TELEMETRY_CONTROLS);
  return Object.fromEntries(kept);
}

/**
 * Merge a newly-reported control map into the stored one. The client reports
 * cumulative per-session totals, so per-key max (not sum) is the right merge —
 * it makes replays/races idempotent instead of double-counting.
 */
export function mergeControlCounts(
  stored: Record<string, number>,
  incoming: Record<string, number>
): Record<string, number> {
  const merged: Record<string, number> = { ...stored };
  for (const [key, count] of Object.entries(incoming)) {
    merged[key] = Math.max(merged[key] ?? 0, count);
  }
  return sanitizeControlCounts(merged);
}

/** Safely parse a stored controlsJson blob back into a counts map. */
export function parseControlCounts(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") counts[key] = value;
    }
    return sanitizeControlCounts(counts);
  } catch {
    return {};
  }
}
