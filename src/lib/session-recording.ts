// Shared, pure helpers for session replay: the limits both the recorder and
// the upload route enforce, event validation, and the builder that turns a raw
// rrweb event stream into the readable timeline on the admin replay page.
//
// No DB / Next / DOM imports, so it unit-tests like resource-telemetry.ts. The
// browser recorder is src/components/session-recorder/, the upload route is
// /api/recordings, and the admin pages live under /admin/session-replays.
//
// Who is recorded: students with research consent on file, on the dashboard
// shell only. Staff are never recorded. Who may watch: administrators and
// research scientists (canViewAdminData) — never teachers, because a recording
// names a participating student and the consent form promises participation is
// not known to the instructor (same rule as resource-telemetry.ts).

import { canViewAdminData } from "./roles";

// ─── Limits ───────────────────────────────────────────────────────────────────

/** How often the browser uploads its buffered events. */
export const RECORDING_FLUSH_INTERVAL_MS = 5_000;
/** Upload early once this many events are buffered (a big DOM snapshot burst). */
export const RECORDING_FLUSH_EVENT_COUNT = 500;
/** A recording older than this is closed and a fresh one (with a new snapshot) begins. */
export const RECORDING_MAX_AGE_MS = 30 * 60_000;

/** Largest request body the upload route reads (base64 of the gzip bytes). */
export const RECORDING_MAX_BODY_BYTES = 1_500_000;
/** Largest gunzipped chunk accepted; also the zip-bomb ceiling. */
export const RECORDING_MAX_CHUNK_RAW_BYTES = 12 * 1024 * 1024;
export const RECORDING_MAX_EVENTS_PER_CHUNK = 5_000;
/** Compressed bytes one recording may store before the client must rotate. */
export const RECORDING_MAX_BYTES = 20 * 1024 * 1024;
/** Compressed bytes one student may store across all recordings. */
export const RECORDING_MAX_BYTES_PER_STUDENT = 1024 * 1024 * 1024;
/** Chunks per recording, a backstop behind the byte cap. */
export const RECORDING_MAX_CHUNKS = 2_000;
/** Recordings are deleted by the worker once older than this. */
export const RECORDING_RETENTION_DAYS = 90;

export const RECORDING_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ─── Who may watch ────────────────────────────────────────────────────────────

export function canViewSessionRecordings(role: unknown): boolean {
  return canViewAdminData(role);
}

// ─── Events ───────────────────────────────────────────────────────────────────

/** The slice of rrweb's `eventWithTime` this module reads. */
export type ReplayEvent = {
  type: number;
  timestamp: number;
  data?: unknown;
};

/** rrweb `EventType` values we branch on. */
export const EVENT_TYPE = {
  FullSnapshot: 2,
  IncrementalSnapshot: 3,
  Meta: 4,
  Custom: 5,
} as const;

/** rrweb `IncrementalSource` values we branch on. */
export const INCREMENTAL_SOURCE = {
  MouseMove: 1,
  MouseInteraction: 2,
  Scroll: 3,
  ViewportResize: 4,
  Input: 5,
  TouchMove: 6,
} as const;

/** Custom event tags emitted by our recorder (and shown on the timeline). */
export const CUSTOM_TAG = {
  Area: "area",
  Navigate: "navigate",
  Click: "click",
  Input: "input",
  Submit: "submit",
  Action: "action",
} as const;

const MIN_TIMESTAMP = Date.UTC(2020, 0, 1);
const MAX_TIMESTAMP = Date.UTC(2100, 0, 1);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural check of an uploaded batch. Deliberately shallow — rrweb event
 * payloads are large and versioned, and the replayer runs them inside a
 * sandboxed iframe behind its own try/catch — but it rejects anything that
 * would break the ordering/timing the server and the replay page rely on.
 */
export function validateReplayEvents(value: unknown): ReplayEvent[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > RECORDING_MAX_EVENTS_PER_CHUNK) {
    return null;
  }
  for (const event of value) {
    if (!isRecord(event)) return null;
    const { type, timestamp, data } = event;
    if (typeof type !== "number" || !Number.isInteger(type)) return null;
    if (type < 0 || type > 6) return null;
    if (
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      timestamp < MIN_TIMESTAMP ||
      timestamp > MAX_TIMESTAMP
    ) {
      return null;
    }
    if (data !== undefined && (typeof data !== "object" || data === null)) {
      return null;
    }
  }
  return value as ReplayEvent[];
}

/** Earliest and latest timestamp in a validated batch. */
export function eventTimeRange(events: ReplayEvent[]): {
  first: number;
  last: number;
} {
  let first = Infinity;
  let last = -Infinity;
  for (const event of events) {
    if (event.timestamp < first) first = event.timestamp;
    if (event.timestamp > last) last = event.timestamp;
  }
  return { first, last };
}

/**
 * A replay needs a full snapshot (type 2) to build the page from. The first
 * batch of every recording must contain one; later batches are increments.
 */
export function hasFullSnapshot(events: ReplayEvent[]): boolean {
  return events.some((event) => event.type === EVENT_TYPE.FullSnapshot);
}

// ─── Areas ────────────────────────────────────────────────────────────────────

export const REPLAY_AREAS = ["quiz", "simulation", "material"] as const;
export type ReplayArea = (typeof REPLAY_AREAS)[number];
export const REPLAY_AREA_LABELS: Record<ReplayArea, string> = {
  quiz: "Quiz taking",
  simulation: "Simulations",
  material: "Learning materials",
};

export function isReplayArea(v: unknown): v is ReplayArea {
  return REPLAY_AREAS.some((area) => area === v);
}

export function areaForPath(path: string): ReplayArea | null {
  const pathname = displayPath(path).split(/[?#]/, 1)[0];
  if (
    /^\/student\/classes\/[^/]+\/quiz\/[^/]+(?:\/practice)?\/?$/.test(pathname)
  )
    return "quiz";
  if (/^\/student\/simulations(?:\/|$)/.test(pathname)) return "simulation";
  if (/^\/student\/materials(?:\/|$)/.test(pathname)) return "material";
  return null;
}

export type AreaSegment = { area: ReplayArea; startMs: number; endMs: number };

/** One active enter per area. Re-entering promotes it; an unmatched leave is harmless. */
function areaTracker(initialPath?: string) {
  let page = initialPath === undefined ? null : areaForPath(initialPath);
  const overlays: ReplayArea[] = [];
  const current = () => overlays.at(-1) ?? page;
  return {
    current,
    accept(event: ReplayEvent) {
      const data = isRecord(event.data) ? event.data : {};
      const payload = isRecord(data.payload) ? data.payload : {};
      const path =
        event.type === EVENT_TYPE.Meta
          ? data.href
          : event.type === EVENT_TYPE.Custom && data.tag === CUSTOM_TAG.Navigate
            ? payload.path
            : undefined;
      if (typeof path === "string") page = areaForPath(path);
      if (
        event.type === EVENT_TYPE.Custom &&
        data.tag === CUSTOM_TAG.Area &&
        isReplayArea(payload.area)
      ) {
        if (payload.state === "enter" || payload.state === "leave") {
          const index = overlays.indexOf(payload.area);
          if (index >= 0) overlays.splice(index, 1);
          if (payload.state === "enter") overlays.push(payload.area);
        }
      }
      return current();
    },
  };
}

function orderedAreaEvents(events: ReplayEvent[]): ReplayEvent[] {
  return events
    .filter(
      (event) =>
        isRecord(event) &&
        typeof event.timestamp === "number" &&
        Number.isFinite(event.timestamp),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Positive-duration intervals; ties retain input order. Does not mutate events. */
export function buildAreaSegments(
  events: ReplayEvent[],
  initialPath?: string,
): AreaSegment[] {
  const ordered = orderedAreaEvents(events);
  if (!ordered.length) return [];
  const start = recordingStart(events);
  const tracker = areaTracker(initialPath);
  const segments: AreaSegment[] = [];
  let previous = 0;
  let area = tracker.current();
  for (const event of ordered) {
    const offset = Math.max(0, event.timestamp - start);
    if (area && offset > previous) {
      const last = segments.at(-1);
      if (last?.area === area && last.endMs === previous) last.endMs = offset;
      else segments.push({ area, startMs: previous, endMs: offset });
    }
    area = tracker.accept(event);
    previous = offset;
  }
  return segments;
}

/** Includes instantaneous touches, even at the final timestamp, in stable area order. */
export function areasInEvents(
  events: ReplayEvent[],
  initialPath?: string,
): ReplayArea[] {
  const tracker = areaTracker(initialPath);
  const touched = new Set<ReplayArea>();
  const initial = tracker.current();
  if (initial) touched.add(initial);
  for (const event of orderedAreaEvents(events)) {
    const area = tracker.accept(event);
    if (area) touched.add(area);
  }
  return REPLAY_AREAS.filter((area) => touched.has(area));
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

export const TIMELINE_KINDS = [
  "page",
  "click",
  "input",
  "scroll",
  "action",
  "resize",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const TIMELINE_KIND_LABELS: Record<TimelineKind, string> = {
  page: "Pages",
  click: "Clicks",
  input: "Typing & choices",
  scroll: "Scrolling",
  action: "Actions",
  resize: "Window",
};

export type TimelineEntry = {
  id: number;
  /** Milliseconds from the first event, the player's time axis. */
  offsetMs: number;
  kind: TimelineKind;
  label: string;
  detail?: string;
  area?: ReplayArea;
};

export type TimelineStats = {
  durationMs: number;
  clicks: number;
  inputs: number;
  scrolls: number;
  mouseMoves: number;
  pages: number;
};

/** Scroll events closer together than this collapse into one entry. */
const SCROLL_GAP_MS = 1_000;

function str(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Path (and query) of a recorded URL, tolerating relative or odd values. */
export function displayPath(href: string): string {
  try {
    const url = new URL(href, "http://localhost");
    return `${url.pathname}${url.search}` || "/";
  } catch {
    return href;
  }
}

/** The first event's timestamp, the zero point of the player and timeline. */
export function recordingStart(events: ReplayEvent[]): number {
  return (
    events.find(
      (event) =>
        isRecord(event) &&
        typeof event.timestamp === "number" &&
        Number.isFinite(event.timestamp),
    )?.timestamp ?? 0
  );
}

/**
 * Turn the raw event stream into readable timeline entries and summary
 * counts. Tolerates malformed events (skips them) so one bad record can't hide
 * the rest of a session. Clicks and typing come from the labeled custom events
 * our recorder emits; rrweb's own pointer events are only counted, because
 * they carry node ids rather than anything a person could read.
 */
export function buildTimeline(events: ReplayEvent[]): {
  entries: TimelineEntry[];
  stats: TimelineStats;
} {
  const start = recordingStart(events);
  const entries: TimelineEntry[] = [];
  const stats: TimelineStats = {
    durationMs: 0,
    clicks: 0,
    inputs: 0,
    scrolls: 0,
    mouseMoves: 0,
    pages: 0,
  };
  let lastScroll: { entry: TimelineEntry; at: number } | null = null;
  let nextId = 0;
  const tracker = areaTracker();

  const push = (
    event: ReplayEvent,
    kind: TimelineKind,
    label: string,
    detail?: string,
  ) => {
    const entry: TimelineEntry = {
      id: nextId++,
      offsetMs: Math.max(0, event.timestamp - start),
      kind,
      label,
      ...(detail ? { detail } : {}),
      ...(tracker.current() ? { area: tracker.current()! } : {}),
    };
    entries.push(entry);
    return entry;
  };

  for (const event of events) {
    if (
      !isRecord(event) ||
      typeof event.timestamp !== "number" ||
      !Number.isFinite(event.timestamp)
    )
      continue;
    tracker.accept(event);
    stats.durationMs = Math.max(stats.durationMs, event.timestamp - start);
    const data = isRecord(event.data) ? event.data : {};

    if (event.type === EVENT_TYPE.Meta) {
      const href = str(data.href, 300);
      if (href) {
        stats.pages += 1;
        push(event, "page", `Opened ${displayPath(href)}`);
      }
    } else if (event.type === EVENT_TYPE.Custom) {
      const payload = isRecord(data.payload) ? data.payload : {};
      switch (data.tag) {
        case CUSTOM_TAG.Navigate: {
          const path = str(payload.path, 300);
          if (path) {
            stats.pages += 1;
            push(event, "page", `Went to ${path}`);
          }
          break;
        }
        case CUSTOM_TAG.Click: {
          stats.clicks += 1;
          const label = str(payload.label) ?? "an element";
          const tag = str(payload.tag, 24);
          push(
            event,
            "click",
            `Clicked ${label}`,
            tag ? `<${tag}>` : undefined,
          );
          break;
        }
        case CUSTOM_TAG.Input: {
          stats.inputs += 1;
          const label = str(payload.label) ?? "a field";
          const value = str(payload.value, 200);
          push(
            event,
            "input",
            value !== undefined
              ? `Entered "${value}" in ${label}`
              : `Changed ${label}`,
          );
          break;
        }
        case CUSTOM_TAG.Submit:
          push(event, "action", `Submitted ${str(payload.label) ?? "a form"}`);
          break;
        case CUSTOM_TAG.Action: {
          const name = str(payload.name);
          if (name) push(event, "action", name, str(payload.detail, 300));
          break;
        }
      }
    } else if (event.type === EVENT_TYPE.IncrementalSnapshot) {
      const source = data.source;
      if (source === INCREMENTAL_SOURCE.MouseMove) {
        stats.mouseMoves += Array.isArray(data.positions)
          ? data.positions.length
          : 1;
      } else if (source === INCREMENTAL_SOURCE.Scroll) {
        stats.scrolls += 1;
        const y = num(data.y);
        const label =
          y !== undefined ? `Scrolled to ${Math.round(y)}px` : "Scrolled";
        if (
          lastScroll &&
          lastScroll.entry.area === (tracker.current() ?? undefined) &&
          event.timestamp - lastScroll.at < SCROLL_GAP_MS
        ) {
          lastScroll.entry.label = label;
          lastScroll.at = event.timestamp;
        } else {
          lastScroll = {
            entry: push(event, "scroll", label),
            at: event.timestamp,
          };
        }
      } else if (source === INCREMENTAL_SOURCE.ViewportResize) {
        const width = num(data.width);
        const height = num(data.height);
        if (width !== undefined && height !== undefined) {
          push(event, "resize", `Window resized to ${width}×${height}`);
        }
      }
    }
  }

  return { entries, stats };
}

/** m:ss (or h:mm:ss) for a millisecond offset. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
