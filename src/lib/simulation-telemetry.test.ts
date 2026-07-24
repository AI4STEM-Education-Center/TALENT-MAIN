import { describe, it, expect } from "vitest";
import {
  SIMULATION_TELEMETRY_SNIPPET,
  SIM_TELEMETRY_MESSAGE_TYPE,
  MAX_TELEMETRY_MS,
  MAX_TELEMETRY_COUNT,
  MAX_TELEMETRY_CONTROLS,
  MAX_CONTROL_LABEL_CHARS,
  injectTelemetryScript,
  clampTelemetryMs,
  clampTelemetryCount,
  sanitizeControlCounts,
  mergeControlCounts,
  parseControlCounts,
} from "./simulation-telemetry";

// ─── The injected snippet ───────────────────────────────────────────────────

describe("SIMULATION_TELEMETRY_SNIPPET", () => {
  it("is a single inline script that reports via postMessage only", () => {
    expect(SIMULATION_TELEMETRY_SNIPPET.startsWith("<script>")).toBe(true);
    expect(SIMULATION_TELEMETRY_SNIPPET.endsWith("</script>")).toBe(true);
    expect(SIMULATION_TELEMETRY_SNIPPET).toContain("parent.postMessage");
    expect(SIMULATION_TELEMETRY_SNIPPET).toContain(`"${SIM_TELEMETRY_MESSAGE_TYPE}"`);
  });

  it("uses none of the network APIs the artifact CSP/validator forbids", () => {
    // Mirrors NETWORK_API_RE in simulation.ts: the sandboxed iframe has no
    // network access, so the snippet must never try.
    expect(SIMULATION_TELEMETRY_SNIPPET).not.toMatch(
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/
    );
    expect(SIMULATION_TELEMETRY_SNIPPET).not.toMatch(/https?:\/\//);
  });
});

describe("injectTelemetryScript", () => {
  it("inserts before </body> when present", () => {
    const html = "<!doctype html><html><body><h1>Sim</h1></body></html>";
    const injected = injectTelemetryScript(html);
    expect(injected.indexOf(SIMULATION_TELEMETRY_SNIPPET)).toBeLessThan(
      injected.indexOf("</body>")
    );
    expect(injected.indexOf(SIMULATION_TELEMETRY_SNIPPET)).toBeGreaterThan(
      injected.indexOf("<h1>Sim</h1>")
    );
  });

  it("falls back to before </html>, matching case-insensitively", () => {
    const html = "<!doctype html><HTML><h1>Sim</h1></HTML>";
    const injected = injectTelemetryScript(html);
    expect(injected).toContain(SIMULATION_TELEMETRY_SNIPPET + "</HTML>");
  });

  it("appends when the document has no closing tags", () => {
    expect(injectTelemetryScript("<h1>fragment</h1>")).toBe(
      "<h1>fragment</h1>" + SIMULATION_TELEMETRY_SNIPPET
    );
  });
});

// ─── Clamps + control-count sanitizing ───────────────────────────────────────

describe("clamping", () => {
  it("clamps durations and counts into their caps", () => {
    expect(clampTelemetryMs(-5)).toBe(0);
    expect(clampTelemetryMs(1234)).toBe(1234);
    expect(clampTelemetryMs(MAX_TELEMETRY_MS + 1)).toBe(MAX_TELEMETRY_MS);
    expect(clampTelemetryCount(Number.NaN)).toBe(0);
    expect(clampTelemetryCount(MAX_TELEMETRY_COUNT * 2)).toBe(MAX_TELEMETRY_COUNT);
  });
});

describe("sanitizeControlCounts", () => {
  it("normalizes labels, drops empties and non-positive counts", () => {
    expect(
      sanitizeControlCounts({ "  Mass \n (kg) ": 3, "": 4, "   ": 1, angle: 0, friction: -2 })
    ).toEqual({ "Mass (kg)": 3 });
  });

  it("truncates long labels and merges the collisions", () => {
    const long = "x".repeat(MAX_CONTROL_LABEL_CHARS + 10);
    const truncated = "x".repeat(MAX_CONTROL_LABEL_CHARS);
    expect(sanitizeControlCounts({ [long]: 2, [truncated]: 3 })).toEqual({ [truncated]: 5 });
  });

  it("caps the entry count, keeping the most-changed controls", () => {
    const input = Object.fromEntries(
      Array.from({ length: MAX_TELEMETRY_CONTROLS + 10 }, (_, i) => [`control-${i}`, i + 1])
    );
    const kept = sanitizeControlCounts(input);
    expect(Object.keys(kept)).toHaveLength(MAX_TELEMETRY_CONTROLS);
    expect(kept[`control-${MAX_TELEMETRY_CONTROLS + 9}`]).toBe(MAX_TELEMETRY_CONTROLS + 10);
    expect(kept["control-0"]).toBeUndefined();
  });
});

describe("mergeControlCounts", () => {
  it("takes the per-key max (cumulative totals, not deltas)", () => {
    expect(mergeControlCounts({ mass: 5, angle: 2 }, { mass: 3, angle: 7, g: 1 })).toEqual({
      mass: 5,
      angle: 7,
      g: 1,
    });
  });

  it("is idempotent under replayed batches", () => {
    const once = mergeControlCounts({ mass: 4 }, { mass: 6 });
    expect(mergeControlCounts(once, { mass: 6 })).toEqual(once);
  });
});

describe("parseControlCounts", () => {
  it("round-trips a stored blob and rejects junk", () => {
    expect(parseControlCounts(JSON.stringify({ mass: 3 }))).toEqual({ mass: 3 });
    expect(parseControlCounts(null)).toEqual({});
    expect(parseControlCounts("nope")).toEqual({});
    expect(parseControlCounts('["array"]')).toEqual({});
    expect(parseControlCounts('{"mass":"NaN","angle":2}')).toEqual({ angle: 2 });
  });
});
