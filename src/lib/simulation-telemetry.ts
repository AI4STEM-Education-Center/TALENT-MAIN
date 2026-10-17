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

// ─── Launch surfaces ─────────────────────────────────────────────────────────
// Every student simulation opens in the same pop-up (SimulationDialog), so a
// session's `surface` records WHERE it was launched from, and the separate
// `viewport` records the device class it ran on. Both are closed sets: the
// session route rejects anything else, and every stats view renders stored
// values through `simulationSurfaceLabel` so legacy rows stay readable.

/**
 * Launch points a student can open a simulation from (stored in
 * SimulationSession.surface for every session recorded since the pop-up):
 *
 * - `quiz_results` — the results shown in the quiz player right after the
 *   student submits a graded attempt (/student/classes/[id]/quiz/[quizId]).
 * - `results_page` — the standalone results page for a past attempt
 *   (/student/results/[attemptId], reached from the exam history).
 * - `library` — the simulations library (/student/simulations), which lists
 *   every simulation for the student's classes, outside any attempt.
 */
export const SIMULATION_SURFACES = [
  "quiz_results",
  "results_page",
  "library",
] as const;
export type SimulationSurface = (typeof SIMULATION_SURFACES)[number];

/**
 * Values written before the pop-up existed, when results-page simulations
 * opened inline: `rail` = the desktop results rail (results right after
 * submitting and the results page were not told apart), `mobile` = its
 * full-screen phone/tablet form. (`library` kept its meaning and is a current
 * value.) Still accepted from cached old clients and rendered by every view.
 */
export const LEGACY_SIMULATION_SURFACES = ["rail", "mobile"] as const;
export type LegacySimulationSurface =
  (typeof LEGACY_SIMULATION_SURFACES)[number];

/** Everything the session route accepts: current surfaces plus legacy ones. */
export const ACCEPTED_SIMULATION_SURFACES = [
  ...SIMULATION_SURFACES,
  ...LEGACY_SIMULATION_SURFACES,
] as const;

/** Human-readable label for every known stored surface value. */
export const SIMULATION_SURFACE_LABELS: Record<
  SimulationSurface | LegacySimulationSurface,
  string
> = {
  quiz_results: "Quiz results (just submitted)",
  results_page: "Results page (past attempt)",
  library: "Simulations library",
  rail: "Results rail (legacy, desktop)",
  mobile: "Results rail (legacy, phone/tablet)",
};

/**
 * Display label for a stored surface value. Unknown values (hand-edited rows,
 * a value from a newer deploy) are shown verbatim rather than hidden.
 */
export function simulationSurfaceLabel(
  surface: string | null | undefined,
): string {
  if (!surface) return "Unknown";
  return Object.prototype.hasOwnProperty.call(
    SIMULATION_SURFACE_LABELS,
    surface,
  )
    ? SIMULATION_SURFACE_LABELS[surface as SimulationSurface]
    : `Other (${surface})`;
}

/**
 * Device class the simulation ran on, from the window width at launch. Breaks
 * match Tailwind's `sm` (640px) and `lg` (1024px) — `lg` is where the results
 * page switches from a stacked to a two-column layout.
 */
export const SIMULATION_VIEWPORTS = ["phone", "tablet", "desktop"] as const;
export type SimulationViewport = (typeof SIMULATION_VIEWPORTS)[number];

export const SIMULATION_VIEWPORT_LABELS: Record<SimulationViewport, string> = {
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Desktop",
};

/** Classify a CSS-pixel window width into a SimulationViewport. */
export function classifyViewport(width: number): SimulationViewport {
  if (width >= 1024) return "desktop";
  if (width >= 640) return "tablet";
  return "phone";
}

/**
 * Display label for a session's device class. Sessions recorded before the
 * `viewport` column existed have it null; their legacy surface still says
 * which layout they ran in (`rail` was desktop-only, `mobile` below it).
 */
export function simulationViewportLabel(
  viewport: string | null | undefined,
  surface?: string | null,
): string {
  if (viewport) {
    return Object.prototype.hasOwnProperty.call(
      SIMULATION_VIEWPORT_LABELS,
      viewport,
    )
      ? SIMULATION_VIEWPORT_LABELS[viewport as SimulationViewport]
      : `Other (${viewport})`;
  }
  if (surface === "rail") return SIMULATION_VIEWPORT_LABELS.desktop;
  if (surface === "mobile") return "Phone/tablet";
  return "Unknown";
}

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
  return injectBeforeBodyEnd(html, SIMULATION_TELEMETRY_SNIPPET);
}

function injectBeforeBodyEnd(html: string, snippet: string): string {
  const lower = html.toLowerCase();
  for (const closer of ["</body>", "</html>"]) {
    const idx = lower.lastIndexOf(closer);
    if (idx !== -1) return html.slice(0, idx) + snippet + html.slice(idx);
  }
  return html + snippet;
}

/** postMessage `type` the escape forwarder uses. */
export const SIM_ESCAPE_MESSAGE_TYPE = "sim-escape";

/**
 * Forwards Escape out of the sandboxed document. Key events inside an iframe
 * never reach the parent, so without this a student whose focus is in the
 * simulation could not close the pop-up with Escape. Not telemetry — it
 * records nothing, so it is served to every viewer regardless of consent.
 * Listens in the bubble phase and skips handled events, so a simulation (or
 * the staff editing layer) that uses Escape itself keeps it.
 */
export const SIMULATION_ESCAPE_SNIPPET = `<script>
(function () {
  if (window.__simEscapeInstalled) return;
  window.__simEscapeInstalled = true;
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    try { parent.postMessage({ type: "${SIM_ESCAPE_MESSAGE_TYPE}" }, "*"); } catch (err) {}
  });
})();
</script>`;

/** Insert the escape forwarder into a served artifact (see injectTelemetryScript). */
export function injectEscapeForwarder(html: string): string {
  return injectBeforeBodyEnd(html, SIMULATION_ESCAPE_SNIPPET);
}

const clampCount = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), max) : 0;

/** Clamp a client-reported millisecond duration into [0, MAX_TELEMETRY_MS]. */
export const clampTelemetryMs = (value: number): number =>
  clampCount(value, MAX_TELEMETRY_MS);

/** Clamp a client-reported counter into [0, MAX_TELEMETRY_COUNT]. */
export const clampTelemetryCount = (value: number): number =>
  clampCount(value, MAX_TELEMETRY_COUNT);

/**
 * Sanitize a client-reported {controlLabel: changeCount} map: normalize and
 * truncate labels, drop empties and non-positive counts, clamp counts, and cap
 * the entry count (keeping the most-changed controls so the cap can't be used
 * to crowd out the real signal).
 */
export function sanitizeControlCounts(
  input: Record<string, number>,
): Record<string, number> {
  const merged = new Map<string, number>();
  for (const [rawKey, rawCount] of Object.entries(input)) {
    const key = rawKey
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CONTROL_LABEL_CHARS);
    const count = clampTelemetryCount(rawCount);
    if (!key || count <= 0) continue;
    merged.set(
      key,
      Math.min((merged.get(key) ?? 0) + count, MAX_TELEMETRY_COUNT),
    );
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
  incoming: Record<string, number>,
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number") counts[key] = value;
    }
    return sanitizeControlCounts(counts);
  } catch {
    return {};
  }
}
