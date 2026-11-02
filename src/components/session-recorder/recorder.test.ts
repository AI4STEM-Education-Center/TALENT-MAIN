// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeElement,
  startSessionRecording,
  flushSessionRecording,
  trackReplayEvent,
} from "./recorder";

const rr = vi.hoisted(() => ({
  record: vi.fn(),
  emit: null as null | ((event: unknown) => void),
  stop: vi.fn(),
  custom: vi.fn(),
}));
vi.mock("@rrweb/record", () => ({
  record: Object.assign(rr.record, { addCustomEvent: rr.custom }),
}));

function el(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

describe("describeElement", () => {
  it("prefers an explicit label, then visible text", () => {
    expect(
      describeElement(
        el('<button aria-label="Close dialog">x</button>', "button"),
      ),
    ).toBe("Close dialog");
    expect(
      describeElement(el("<button>  Submit   quiz </button>", "button")),
    ).toBe("Submit quiz");
  });

  it("names an input by its label or placeholder", () => {
    expect(
      describeElement(
        el('<label>Email <input id="a" type="email"></label>', "input"),
      ),
    ).toBe("Email");
    expect(
      describeElement(el('<input placeholder="Search students…">', "input")),
    ).toBe("Search students…");
  });

  it("never leaks text from blocked or masked regions", () => {
    expect(
      describeElement(
        el(
          '<div class="rr-block"><button>Secret UGA ID</button></div>',
          "button",
        ),
      ),
    ).toBe("button");
    expect(describeElement(el('<p class="rr-mask">Private</p>', "p"))).toBe(
      "p",
    );
  });

  it("does not label a layout container with everything inside it", () => {
    expect(
      describeElement(
        el(`<main>${"Lots of page text. ".repeat(10)}</main>`, "main"),
      ),
    ).toBe("main");
    expect(describeElement(el("<h2>My Classes</h2>", "h2"))).toBe("My Classes");
  });

  it("truncates long text", () => {
    const label = describeElement(
      el(`<button>${"x".repeat(200)}</button>`, "button"),
    );
    expect(label.length).toBe(80);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("recorder lifecycle", () => {
  let cleanup: (() => void) | undefined;
  const fetchMock = vi.fn();
  const snapshot = () => ({
    type: 2,
    timestamp: Date.now(),
    data: { node: {} },
  });
  const event = () => ({ type: 3, timestamp: Date.now(), data: { source: 3 } });
  const posts = () =>
    fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
  async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  async function begin(allowed = true) {
    fetchMock.mockImplementation(async (_url, options) =>
      options?.method === "POST"
        ? { ok: true, json: async () => ({ accepted: true }) }
        : { ok: true, json: async () => ({ allowed }) },
    );
    const stopped = vi.fn();
    cleanup = startSessionRecording(stopped);
    await settle();
    return stopped;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    rr.emit = null;
    rr.record.mockReset().mockImplementation((options) => {
      rr.emit = options.emit;
      options.emit(snapshot());
      return rr.stop;
    });
    rr.stop.mockClear();
    rr.custom
      .mockReset()
      .mockImplementation((tag, payload) =>
        rr.emit?.({ type: 5, timestamp: Date.now(), data: { tag, payload } }),
      );
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("CompressionStream", undefined);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never starts rrweb without consent, and can start after a new decision", async () => {
    expect(await begin(false)).toHaveBeenCalledWith("no_consent");
    expect(rr.record).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
    await begin(true);
    expect(rr.record).toHaveBeenCalledTimes(1);
    await flushSessionRecording();
    expect(posts()).toHaveLength(1);
  });

  it("blocks private DOM surfaces and custom events, including masked descendants in labels", async () => {
    await begin();
    const options = rr.record.mock.calls[0][0];
    const privateInput = el('<input type="file">', "input");
    expect(privateInput.matches(options.blockSelector)).toBe(true);
    document.body.innerHTML =
      '<div class="rr-block"><form name="SECRET"><input value="SECRET"><button type="button">SECRET</button></form></div>';
    document
      .querySelector("input")!
      .dispatchEvent(new Event("change", { bubbles: true }));
    document
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true }));
    expect(rr.custom).not.toHaveBeenCalled();
    expect(
      describeElement(
        el(
          '<button>Open <span class="rr-mask">SECRET</span></button>',
          "button",
        ),
      ),
    ).toBe("Open");
    expect(
      describeElement(
        el(
          '<label>Public <span class="rr-block">SECRET</span><input></label>',
          "input",
        ),
      ),
    ).toBe("Public");
  });

  it("drops queued old batches after rotation and restarts sequence with a snapshot", async () => {
    await begin();
    let release!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = flushSessionRecording();
    await settle();
    rr.emit?.(event());
    const queued = flushSessionRecording();
    release({ ok: true, json: async () => ({ stop: "recording_full" }) });
    await first;
    await queued;
    expect(posts()).toHaveLength(1);
    expect(rr.record).toHaveBeenCalledTimes(2);
    await flushSessionRecording();
    const bodies = posts().map(([, options]) => JSON.parse(options.body));
    expect(bodies[1].recordingId).not.toBe(bodies[0].recordingId);
    expect(bodies[1].seq).toBe(0);
    expect(JSON.parse(bodies[1].data)[0].type).toBe(2);
  });

  it("retries the identical batch and sequence after a transient failure", async () => {
    await begin();
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500 }));
    const flushing = flushSessionRecording();
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await flushing;
    expect(posts()).toHaveLength(2);
    expect(posts()[1][1].body).toBe(posts()[0][1].body);
  });

  it("does not let pagehide overtake a pending upload or consume a rejected beacon sequence", async () => {
    await begin();
    let release!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const flushing = flushSessionRecording();
    await settle();
    rr.emit?.(event());
    window.dispatchEvent(new Event("pagehide"));
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
    release({ ok: true, json: async () => ({ accepted: true }) });
    await flushing;
    vi.mocked(navigator.sendBeacon).mockReturnValue(false);
    window.dispatchEvent(new Event("pagehide"));
    await flushSessionRecording();
    expect(JSON.parse(posts()[1][1].body).seq).toBe(1);
  });

  it("rotates only once while an aged recording is flushing", async () => {
    await begin();
    vi.setSystemTime(Date.now() + 31 * 60_000);
    let release!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rr.stop).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
    release({ ok: true, json: async () => ({ accepted: true }) });
    await settle();
    expect(rr.record).toHaveBeenCalledTimes(2);
  });

  it("does not begin a second recorder when the age flush also hits the server cap", async () => {
    await begin();
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({ stop: "recording_full" }),
    }));
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rr.record).toHaveBeenCalledTimes(2);
    expect(rr.stop).toHaveBeenCalledTimes(1);
  });

  it("bounds the actual queued bytes while an upload is stalled", async () => {
    const stopped = await begin();
    let release!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const flushing = flushSessionRecording();
    await settle();
    for (let i = 0; i < 30; i++) {
      rr.emit?.({
        type: 3,
        timestamp: Date.now(),
        data: { text: "x".repeat(1024 * 1024) },
      });
    }
    expect(stopped).toHaveBeenCalledWith("overflow");
    release({ ok: true, json: async () => ({ accepted: true }) });
    await flushing;
    await settle();
    expect(posts()).toHaveLength(1);
  });

  it("stops safely when an opening snapshot cannot fit an upload", async () => {
    rr.record.mockImplementation((options) => {
      rr.emit = options.emit;
      options.emit({
        type: 4,
        timestamp: Date.now(),
        data: { href: location.href },
      });
      options.emit({
        type: 2,
        timestamp: Date.now(),
        data: { text: "x".repeat(2 * 1024 * 1024) },
      });
      return rr.stop;
    });
    const stopped = await begin();
    await flushSessionRecording();
    expect(stopped).toHaveBeenCalledWith("overflow");
    expect(posts()).toHaveLength(0);
  });

  it("measures beacon limits in UTF-8 bytes and keeps an oversized tail for the next upload", async () => {
    await begin();
    await flushSessionRecording();
    rr.emit?.({
      type: 3,
      timestamp: Date.now(),
      data: { text: "😀".repeat(20_000) },
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
    await flushSessionRecording();
    expect(JSON.parse(posts()[1][1].body).seq).toBe(1);
  });

  it("bounds memory during stalled uploads and stops capture immediately on cleanup", async () => {
    const stopped = await begin();
    rr.emit?.({
      type: 3,
      timestamp: Date.now(),
      data: { text: "x".repeat(13 * 1024 * 1024) },
    });
    expect(stopped).toHaveBeenCalledWith("overflow");
    expect(rr.stop).toHaveBeenCalledTimes(1);
    await begin();
    cleanup?.();
    expect(rr.stop).toHaveBeenCalledTimes(2);
    await flushSessionRecording();
    expect(posts()).toHaveLength(0);
  });

  it("preserves overlays opened during the consent check and promotes reentered areas", async () => {
    fetchMock.mockImplementation(async (_url, options) =>
      options?.method === "POST"
        ? { ok: true, json: async () => ({ accepted: true }) }
        : { ok: true, json: async () => ({ allowed: true }) },
    );
    cleanup = startSessionRecording(vi.fn());
    trackReplayEvent("area", { area: "simulation", state: "enter" });
    trackReplayEvent("area", { area: "material", state: "enter" });
    trackReplayEvent("area", { area: "simulation", state: "enter" });
    await settle();
    await flushSessionRecording();
    const body = JSON.parse(posts()[0][1].body);
    const events = JSON.parse(body.data);
    expect(
      events
        .slice(0, 2)
        .map(
          (e: { data: { payload: { area: string } } }) => e.data.payload.area,
        ),
    ).toEqual(["material", "simulation"]);
  });
});
