// Browser-side session recorder: captures the page with rrweb, adds labeled
// click / input / form / navigation events a person can read on the admin
// timeline, and uploads the stream to /api/recordings in gzip batches.
//
// rrweb is imported lazily so it costs nothing until a recording starts. The
// server decides who is recorded (research consent) — it answers the first
// upload with a `stop` reason when someone shouldn't be — so this file never
// stores anything on the device and sends nothing a non-consenting student
// could be identified by beyond that one rejected batch, which the server
// discards.
//
// Privacy defaults: password fields are masked by rrweb; anything inside an
// element with the `rr-block` class (the consent form's signature and UGA ID)
// is not captured at all, and `rr-mask` hides text and values.

import {
  CUSTOM_TAG,
  RECORDING_FLUSH_EVENT_COUNT,
  RECORDING_FLUSH_INTERVAL_MS,
  RECORDING_MAX_AGE_MS,
  RECORDING_MAX_BODY_BYTES,
  type ReplayEvent,
} from "@/lib/session-recording";

type RrwebRecord = typeof import("@rrweb/record").record;

const ENDPOINT = "/api/recordings";
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];
/** sendBeacon payloads are capped near 64 KB. */
const BEACON_MAX_BYTES = 60_000;
const PRIVATE_SELECTOR = ".rr-block, .rr-mask, .rr-ignore";

type StopReason = "no_consent" | "recording_full" | "quota" | "restart";
type UploadOutcome = "ok" | "rotate" | "stop" | "retry";

let active: SessionRecorder | null = null;

/** Add a named action to the recording's timeline. No-op when not recording. */
export function trackReplayEvent(
  tag: string,
  payload: Record<string, unknown>,
): void {
  active?.custom(tag, payload);
}

/** Upload whatever is buffered now (used before sign-out). */
export async function flushSessionRecording(): Promise<void> {
  await active?.flush(true);
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const CLICK_TARGET =
  "button, a, input, select, textarea, label, summary, [role='button'], [role='tab'], [role='menuitem'], [role='checkbox'], [role='switch'], [role='option'], [data-replay-label]";

/** A short human label for the element a person interacted with. */
export function describeElement(el: Element): string {
  if (el.closest(PRIVATE_SELECTOR)) return el.tagName.toLowerCase();
  const attr = (name: string) => el.getAttribute(name)?.trim() || "";
  const labelled = el as HTMLElement & {
    labels?: NodeListOf<HTMLLabelElement>;
  };
  const fromLabels = labelled.labels?.[0]?.textContent ?? "";
  const rawText =
    el instanceof HTMLInputElement &&
    ["button", "submit", "reset"].includes(el.type)
      ? el.value
      : (el.textContent ?? "");
  // A click on a layout container would otherwise be labeled with everything
  // inside it; only controls and short text are worth naming.
  const text =
    el.matches(CLICK_TARGET) || rawText.trim().length <= 40 ? rawText : "";
  return (
    truncate(
      attr("aria-label") ||
        attr("data-replay-label") ||
        fromLabels ||
        text ||
        attr("title") ||
        attr("alt") ||
        attr("placeholder") ||
        attr("name") ||
        attr("id") ||
        "",
      80,
    ) || el.tagName.toLowerCase()
  );
}

function inputValue(el: Element): string | undefined {
  if (el.closest(PRIVATE_SELECTOR)) return undefined;
  if (el instanceof HTMLInputElement) {
    if (el.type === "password") return undefined;
    if (el.type === "checkbox" || el.type === "radio") {
      return el.checked ? "checked" : "unchecked";
    }
    if (el.type === "file") return undefined;
    return truncate(el.value, 200);
  }
  if (el instanceof HTMLTextAreaElement) return truncate(el.value, 200);
  if (el instanceof HTMLSelectElement) {
    return truncate(el.selectedOptions[0]?.textContent ?? el.value, 200);
  }
  return undefined;
}

async function gzipBase64(json: string): Promise<string | null> {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([json])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class SessionRecorder {
  private record: RrwebRecord | null = null;
  private stopRrweb: (() => void) | null = null;
  private recordingId = "";
  private startedAt = 0;
  private entryPath = "";
  private seq = 0;
  private buffer: ReplayEvent[] = [];
  // The page the student was on, and where the buffered batch began, so the
  // server can attribute a batch with no navigation event to the right area.
  private pathNow = "";
  // Areas (simulation pop-up, material reader) currently open. Each batch
  // restates them so it can be classified without the batch that opened them.
  private openAreas = new Set<string>();
  private bufferStartPath = "";
  private uploads: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private onStop: (reason: StopReason | "unauthorized") => void;

  constructor(onStop: (reason: StopReason | "unauthorized") => void) {
    this.onStop = onStop;
  }

  async start(): Promise<void> {
    const { record } = await import("@rrweb/record");
    if (this.disposed) return;
    this.record = record;
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("change", this.onChange, true);
    document.addEventListener("submit", this.onSubmit, true);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    this.timer = setInterval(
      () => void this.tick(),
      RECORDING_FLUSH_INTERVAL_MS,
    );
    this.begin();
  }

  private begin() {
    if (!this.record || this.disposed) return;
    this.recordingId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.entryPath = `${location.pathname}${location.search}`.slice(0, 300);
    this.pathNow = this.entryPath;
    this.seq = 0;
    this.buffer = [];
    this.stopRrweb =
      this.record({
        emit: (event) => this.onEvent(event as unknown as ReplayEvent),
        maskInputOptions: { password: true },
        blockClass: "rr-block",
        maskTextClass: "rr-mask",
        ignoreClass: "rr-ignore",
        sampling: { mousemove: 100, scroll: 150, input: "last" },
        recordCanvas: false,
        collectFonts: false,
      }) ?? null;
  }

  custom(tag: string, payload: Record<string, unknown>) {
    if (this.disposed || !this.record) return;
    this.record.addCustomEvent(tag, payload);
    if (tag === CUSTOM_TAG.Navigate && typeof payload.path === "string") {
      this.pathNow = payload.path.slice(0, 300);
    } else if (tag === CUSTOM_TAG.Area && typeof payload.area === "string") {
      if (payload.state === "leave") this.openAreas.delete(payload.area);
      else this.openAreas.add(payload.area);
    }
  }

  private onEvent(event: ReplayEvent) {
    if (this.buffer.length === 0) {
      this.bufferStartPath = this.pathNow;
      for (const area of this.openAreas) {
        this.buffer.push({
          type: 5,
          timestamp: event.timestamp,
          data: { tag: CUSTOM_TAG.Area, payload: { area, state: "enter" } },
        });
      }
    }
    this.buffer.push(event);
    if (this.buffer.length >= RECORDING_FLUSH_EVENT_COUNT) void this.flush();
  }

  private onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest(CLICK_TARGET) ?? event.target;
    this.custom(CUSTOM_TAG.Click, {
      label: describeElement(target),
      tag: target.tagName.toLowerCase(),
      ...(target instanceof HTMLAnchorElement &&
      !target.closest(PRIVATE_SELECTOR)
        ? { href: target.pathname }
        : {}),
    });
  };

  private onChange = (event: Event) => {
    const el = event.target;
    if (!(el instanceof Element)) return;
    this.custom(CUSTOM_TAG.Input, {
      label: describeElement(el),
      value: inputValue(el),
    });
  };

  private onSubmit = (event: SubmitEvent) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    this.custom(CUSTOM_TAG.Submit, {
      label:
        form.getAttribute("aria-label") || form.getAttribute("name") || "form",
    });
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") void this.flush(true);
  };

  /** Last chance on unload: only a small plain-JSON beacon can still leave. */
  private onPageHide = () => {
    if (this.buffer.length === 0 || !this.recordingId) return;
    const events = this.buffer;
    this.buffer = [];
    const body = JSON.stringify(
      this.payload(
        this.seq++,
        "json",
        JSON.stringify(events),
        true,
        this.bufferStartPath,
      ),
    );
    if (body.length <= BEACON_MAX_BYTES) {
      navigator.sendBeacon(
        ENDPOINT,
        new Blob([body], { type: "application/json" }),
      );
    }
  };

  private async tick() {
    if (this.disposed) return;
    const aged = Date.now() - this.startedAt >= RECORDING_MAX_AGE_MS;
    if (aged && this.buffer.length > 0) {
      await this.rotate();
    } else {
      await this.flush();
    }
  }

  /** Close this recording and begin a new one with a fresh opening snapshot. */
  private async rotate() {
    await this.flush(true, true);
    this.stopRrweb?.();
    this.stopRrweb = null;
    this.begin();
  }

  private payload(
    seq: number,
    encoding: "gzip" | "json",
    data: string,
    final: boolean,
    path?: string,
  ) {
    return {
      recordingId: this.recordingId,
      seq,
      startedAt: this.startedAt,
      entryPath: this.entryPath,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      encoding,
      data,
      ...(path ? { path } : {}),
      ...(final ? { final: true } : {}),
    };
  }

  /** Queue everything buffered for upload; resolves when the queue drains. */
  flush(keepalive = false, final = false): Promise<void> {
    if (this.buffer.length > 0 || final) {
      const events = this.buffer;
      this.buffer = [];
      const recordingId = this.recordingId;
      const path = this.bufferStartPath;
      this.uploads = this.uploads.then(() =>
        this.send(recordingId, events, keepalive, final, path),
      );
    }
    return this.uploads;
  }

  private async send(
    recordingId: string,
    events: ReplayEvent[],
    keepalive: boolean,
    final: boolean,
    path?: string,
  ) {
    if (this.disposed || events.length === 0) return;
    const json = JSON.stringify(events);
    const gz = await gzipBase64(json);
    const encoding = gz === null ? "json" : "gzip";
    const data = gz ?? json;
    if (data.length > RECORDING_MAX_BODY_BYTES) {
      if (events.length > 1) {
        const mid = Math.ceil(events.length / 2);
        await this.send(
          recordingId,
          events.slice(0, mid),
          keepalive,
          false,
          path,
        );
        await this.send(recordingId, events.slice(mid), keepalive, final);
      }
      return;
    }

    const seq = this.seq++;
    const body = JSON.stringify({
      ...this.payload(seq, encoding, data, final, path),
      recordingId,
    });
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.post(body, keepalive);
      if (outcome === "ok") return;
      if (outcome === "stop") return;
      if (outcome === "rotate") {
        // The recording is full or lost its opening snapshot.
        if (recordingId === this.recordingId) {
          this.stopRrweb?.();
          this.stopRrweb = null;
          this.begin();
        }
        return;
      }
      if (attempt >= RETRY_DELAYS_MS.length || this.disposed) {
        // Give up on this batch; start a clean recording so later events
        // aren't replayed on top of a gap.
        if (recordingId === this.recordingId && !this.disposed) {
          this.stopRrweb?.();
          this.stopRrweb = null;
          this.begin();
        }
        return;
      }
      await wait(RETRY_DELAYS_MS[attempt]);
    }
  }

  private async post(body: string, keepalive: boolean): Promise<UploadOutcome> {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: keepalive && body.length < BEACON_MAX_BYTES,
      });
      if (res.status === 401 || res.status === 403) {
        this.stopWith("unauthorized");
        return "stop";
      }
      if (!res.ok)
        return res.status >= 500 || res.status === 429 ? "retry" : "stop";
      const result = (await res.json()) as {
        accepted?: boolean;
        stop?: StopReason;
      };
      if (result.accepted) return "ok";
      if (result.stop === "recording_full" || result.stop === "restart") {
        return "rotate";
      }
      this.stopWith(result.stop ?? "quota");
      return "stop";
    } catch {
      return "retry";
    }
  }

  private stopWith(reason: StopReason | "unauthorized") {
    this.dispose();
    this.onStop(reason);
  }

  /** Stop recording and release every listener. Does not upload. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (active === this) active = null;
    if (this.timer) clearInterval(this.timer);
    this.stopRrweb?.();
    this.stopRrweb = null;
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("change", this.onChange, true);
    document.removeEventListener("submit", this.onSubmit, true);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
  }

  /** End the recording cleanly: upload the tail and mark it finished. */
  async finish() {
    if (this.disposed) return;
    await this.flush(true, true);
    this.dispose();
  }
}

/**
 * Begin recording this tab. Returns a function that finishes the recording.
 * `onStop` fires when the server or the session says to stop (no consent,
 * quota, signed out), after which nothing more is captured.
 */
export function startSessionRecording(
  onStop: (reason: StopReason | "unauthorized") => void,
): () => void {
  const recorder = new SessionRecorder(onStop);
  active = recorder;
  void recorder.start().catch(() => recorder.dispose());
  return () => void recorder.finish();
}
