"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@rrweb/replay/dist/style.css";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  REPLAY_AREAS,
  REPLAY_AREA_LABELS,
  TIMELINE_KINDS,
  TIMELINE_KIND_LABELS,
  buildAreaSegments,
  buildTimeline,
  formatOffset,
  recordingStart,
  type AreaSegment,
  type ReplayArea,
  type ReplayEvent,
  type TimelineKind,
} from "@/lib/session-recording";
import { cn } from "@/lib/utils";

type ReplayerConstructor = typeof import("@rrweb/replay").Replayer;
type ReplayerInstance = InstanceType<ReplayerConstructor>;

const SPEEDS = [0.5, 1, 2, 4, 8] as const;
const KIND_TONE: Record<TimelineKind, string> = {
  page: "bg-blue-500",
  click: "bg-emerald-500",
  input: "bg-amber-500",
  scroll: "bg-slate-400",
  action: "bg-violet-500",
  resize: "bg-rose-400",
};

/**
 * Loads a stored session recording chunk by chunk and plays it back in a
 * sandboxed rrweb replayer beside a filterable, clickable timeline of what the
 * student did. rrweb rebuilds the page inside an iframe with scripts disabled,
 * so recorded content can't run in the admin's session.
 */
export function SessionReplayPlayer({
  recordingId,
  chunkSeqs,
  viewport,
  initialArea = null,
}: {
  recordingId: string;
  chunkSeqs: number[];
  viewport: { width: number; height: number };
  /** Open focused on one part of the session (from the list's area filter). */
  initialArea?: ReplayArea | null;
}) {
  const [events, setEvents] = useState<ReplayEvent[] | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Fetch every chunk in order; a long session is many small requests rather
  // than one huge response.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all: ReplayEvent[] = [];
      for (const seq of chunkSeqs) {
        const res = await fetch(
          `/api/admin/session-recordings/${recordingId}/chunks/${seq}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`Chunk ${seq} failed to load.`);
        const body = (await res.json()) as { events: ReplayEvent[] };
        all.push(...body.events);
        if (cancelled) return;
        setLoaded(seq + 1);
      }
      all.sort((a, b) => a.timestamp - b.timestamp);
      if (!cancelled) setEvents(all);
    })().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : "Failed to load.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [recordingId, chunkSeqs]);

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!events) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading recording… {Math.min(loaded, chunkSeqs.length)} of{" "}
        {chunkSeqs.length} parts
      </p>
    );
  }
  return (
    <LoadedPlayer
      events={events}
      viewport={viewport}
      initialArea={initialArea}
    />
  );
}

const AREA_TONE: Record<ReplayArea, string> = {
  quiz: "bg-sky-500",
  simulation: "bg-fuchsia-500",
  material: "bg-teal-500",
};

/** The segment containing `ms`, or the first one starting after it. */
function segmentAtOrAfter(segments: AreaSegment[], ms: number) {
  return (
    segments.find((segment) => ms >= segment.startMs && ms < segment.endMs) ??
    segments.find((segment) => segment.startMs > ms) ??
    null
  );
}

function LoadedPlayer({
  events,
  viewport,
  initialArea,
}: {
  events: ReplayEvent[];
  viewport: { width: number; height: number };
  initialArea: ReplayArea | null;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<ReplayerInstance | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [skipInactive, setSkipInactive] = useState(true);
  const [timeMs, setTimeMs] = useState(0);
  const [dims, setDims] = useState(viewport);
  const [stageWidth, setStageWidth] = useState(0);
  const [shown, setShown] = useState<Set<TimelineKind>>(
    () => new Set(TIMELINE_KINDS.filter((kind) => kind !== "scroll")),
  );
  const activeRowRef = useRef<HTMLButtonElement>(null);

  const { entries, stats } = useMemo(() => buildTimeline(events), [events]);
  const allSegments = useMemo(() => buildAreaSegments(events), [events]);
  const areaTimeMs = useMemo(() => {
    const totals: Record<ReplayArea, number> = {
      quiz: 0,
      simulation: 0,
      material: 0,
    };
    for (const segment of allSegments) {
      totals[segment.area] += segment.endMs - segment.startMs;
    }
    return totals;
  }, [allSegments]);
  // null = the whole session; otherwise only this part is shown and played.
  const [area, setArea] = useState<ReplayArea | null>(() =>
    initialArea && allSegments.some((segment) => segment.area === initialArea)
      ? initialArea
      : null,
  );
  const focusSegments = useMemo(
    () => (area ? allSegments.filter((segment) => segment.area === area) : []),
    [allSegments, area],
  );
  const focusRef = useRef<AreaSegment[]>([]);
  useEffect(() => {
    focusRef.current = focusSegments;
  }, [focusSegments]);
  const start = recordingStart(events);
  const durationMs = Math.max(
    stats.durationMs,
    events.length > 0 ? events[events.length - 1].timestamp - start : 0,
  );

  // rrweb's replayer is loaded on demand; the effect below builds one per
  // recording once the class is available, so its subscriptions are created
  // and released in the same synchronous effect.
  const [ReplayerClass, setReplayerClass] =
    useState<ReplayerConstructor | null>(null);
  useEffect(() => {
    let cancelled = false;
    import("@rrweb/replay")
      .then((mod) => {
        if (!cancelled) setReplayerClass(() => mod.Replayer);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFailed(
            err instanceof Error ? err.message : "Could not start replay.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ReplayerClass) return;
    const onResize = (size: unknown) => {
      const { width, height } = size as { width: number; height: number };
      if (width > 0 && height > 0) setDims({ width, height });
    };
    const onFinish = () => setPlaying(false);
    let replayer: ReplayerInstance;
    try {
      replayer = new ReplayerClass(events as never, {
        root: host,
        skipInactive: true,
        showWarning: false,
        mouseTail: { strokeStyle: "#ef4444", lineWidth: 2 },
        UNSAFE_replayCanvas: false,
      });
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Could not start replay.");
      return;
    }
    replayer.on("resize", onResize);
    replayer.on("finish", onFinish);
    replayerRef.current = replayer;
    replayer.pause(0);
    setReady(true);
    return () => {
      replayerRef.current = null;
      replayer.off("resize", onResize);
      replayer.off("finish", onFinish);
      try {
        replayer.destroy();
      } catch {
        // The replayer may already be torn down with its host.
      }
      host.replaceChildren();
      setReady(false);
    };
  }, [ReplayerClass, events]);

  // Keep the stage's width so the recorded viewport can be scaled to fit.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => setStageWidth(stage.clientWidth));
    observer.observe(stage);
    setStageWidth(stage.clientWidth);
    return () => observer.disconnect();
  }, []);

  const scale = stageWidth > 0 ? Math.min(1, stageWidth / dims.width) : 1;

  // Poll the playhead; rrweb has no per-frame callback.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const replayer = replayerRef.current;
      if (!replayer) return;
      const now = Math.min(durationMs, replayer.getCurrentTime());
      const segments = focusRef.current;
      if (segments.length > 0) {
        // Focused on one area: hop over everything outside it.
        const inside = segments.some(
          (segment) => now >= segment.startMs && now < segment.endMs,
        );
        if (!inside) {
          const next = segmentAtOrAfter(segments, now);
          if (next && next.startMs > now) {
            replayer.play(next.startMs);
            setTimeMs(next.startMs);
          } else {
            replayer.pause(segments[segments.length - 1].endMs);
            setPlaying(false);
            setTimeMs(segments[segments.length - 1].endMs);
          }
          return;
        }
      }
      setTimeMs(now);
    }, 100);
    return () => clearInterval(id);
  }, [playing, durationMs]);

  const seek = useCallback(
    (ms: number) => {
      const replayer = replayerRef.current;
      if (!replayer) return;
      const target = Math.max(0, Math.min(durationMs, ms));
      if (playing) replayer.play(target);
      else replayer.pause(target);
      setTimeMs(target);
    },
    [durationMs, playing],
  );

  const togglePlay = () => {
    const replayer = replayerRef.current;
    if (!replayer) return;
    if (playing) {
      replayer.pause();
      setPlaying(false);
    } else {
      let from = timeMs >= durationMs ? 0 : timeMs;
      if (focusSegments.length > 0) {
        // Resume inside the focused area; restart it once it has finished.
        const next = segmentAtOrAfter(focusSegments, from) ?? focusSegments[0];
        if (from < next.startMs || from >= next.endMs) from = next.startMs;
      }
      replayer.play(from);
      setTimeMs(from);
      setPlaying(true);
    }
  };

  const changeSpeed = (next: number) => {
    setSpeed(next);
    replayerRef.current?.setConfig({ speed: next });
  };

  const changeSkip = (next: boolean) => {
    setSkipInactive(next);
    replayerRef.current?.setConfig({ skipInactive: next });
  };

  // Opened on a specific area: start at its first moment once playable.
  useEffect(() => {
    if (!ready || !area) return;
    const first = focusRef.current[0];
    if (first) {
      replayerRef.current?.pause(first.startMs);
      setTimeMs(first.startMs);
    }
  }, [ready, area]);

  const chooseArea = (next: ReplayArea | null) => {
    setArea(next);
    const first = next
      ? allSegments.find((segment) => segment.area === next)
      : null;
    if (first) seek(first.startMs);
  };

  const visible = entries.filter(
    (entry) => shown.has(entry.kind) && (!area || entry.area === area),
  );
  const activeId = useMemo(() => {
    let id = -1;
    for (const entry of visible) {
      if (entry.offsetMs <= timeMs) id = entry.id;
      else break;
    }
    return id;
  }, [visible, timeMs]);

  // Follow the playhead in the timeline without hijacking page scroll.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const toggleKind = (kind: TimelineKind) =>
    setShown((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  if (failed) return <p className="text-sm text-destructive">{failed}</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-3 min-w-0">
        <div
          role="tablist"
          aria-label="Part of the session"
          className="flex flex-wrap gap-1.5"
        >
          {[
            { value: null, label: "Whole session", ms: durationMs },
            ...REPLAY_AREAS.map((value) => ({
              value,
              label: REPLAY_AREA_LABELS[value],
              ms: areaTimeMs[value],
            })),
          ].map((tab) => {
            const empty = tab.value !== null && tab.ms <= 0;
            return (
              <button
                key={tab.value ?? "all"}
                type="button"
                role="tab"
                aria-selected={area === tab.value}
                disabled={empty || !ready}
                onClick={() => chooseArea(tab.value)}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-40",
                  area === tab.value
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent",
                )}
              >
                {tab.label}
                <span className="ml-1.5 text-xs opacity-75">
                  {empty ? "none" : formatOffset(tab.ms)}
                </span>
              </button>
            );
          })}
        </div>
        <div
          ref={stageRef}
          className="w-full overflow-hidden rounded-lg border bg-muted/30"
          style={{ height: dims.height * scale }}
        >
          <div
            ref={hostRef}
            style={{
              width: dims.width,
              height: dims.height,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={togglePlay}
            disabled={!ready}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4" />
            )}
            {playing ? "Pause" : "Play"}
          </Button>
          <span className="w-24 text-sm tabular-nums text-muted-foreground">
            {formatOffset(timeMs)} / {formatOffset(durationMs)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, durationMs)}
            value={timeMs}
            disabled={!ready}
            aria-label="Playback position"
            onChange={(event) => seek(Number(event.target.value))}
            className="min-w-40 flex-1"
          />
          <label className="flex items-center gap-1 text-sm">
            Speed
            <select
              value={speed}
              onChange={(event) => changeSpeed(Number(event.target.value))}
              className="h-8 rounded-md border bg-background px-2"
            >
              {SPEEDS.map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={skipInactive}
              onChange={(event) => changeSkip(event.target.checked)}
            />
            Skip idle time
          </label>
        </div>
        {allSegments.length > 0 && (
          <div
            aria-hidden="true"
            className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted"
          >
            {allSegments.map((segment) => (
              <span
                key={`${segment.area}-${segment.startMs}`}
                title={`${REPLAY_AREA_LABELS[segment.area]} ${formatOffset(segment.startMs)}–${formatOffset(segment.endMs)}`}
                className={cn(
                  "absolute inset-y-0",
                  AREA_TONE[segment.area],
                  area && segment.area !== area && "opacity-25",
                )}
                style={{
                  left: `${(segment.startMs / Math.max(1, durationMs)) * 100}%`,
                  width: `${Math.max(0.5, ((segment.endMs - segment.startMs) / Math.max(1, durationMs)) * 100)}%`,
                }}
              />
            ))}
          </div>
        )}
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
          {[
            ["Duration", formatOffset(durationMs)],
            ["Pages", stats.pages],
            ["Clicks", stats.clicks],
            ["Inputs", stats.inputs],
            ["Scrolls", stats.scrolls],
          ].map(([label, value]) => (
            <div key={label} className="rounded-md border p-2">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <aside className="flex min-h-0 flex-col rounded-lg border">
        <div className="flex flex-wrap gap-1.5 border-b p-2">
          {TIMELINE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={shown.has(kind)}
              onClick={() => toggleKind(kind)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                shown.has(kind)
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground opacity-60",
              )}
            >
              <span className={cn("size-2 rounded-full", KIND_TONE[kind])} />
              {TIMELINE_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
        <ol className="max-h-[32rem] flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <li className="p-4 text-sm text-muted-foreground">
              Nothing to show for these filters.
            </li>
          ) : (
            visible.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  ref={entry.id === activeId ? activeRowRef : undefined}
                  onClick={() => seek(entry.offsetMs)}
                  className={cn(
                    "flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm hover:bg-accent/60",
                    entry.id === activeId && "bg-accent",
                  )}
                >
                  <span className="w-11 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                    {formatOffset(entry.offsetMs)}
                  </span>
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      KIND_TONE[entry.kind],
                    )}
                  />
                  <span className="min-w-0 break-words">
                    {entry.label}
                    {entry.detail && (
                      <span className="block text-xs text-muted-foreground">
                        {entry.detail}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))
          )}
        </ol>
      </aside>
    </div>
  );
}
