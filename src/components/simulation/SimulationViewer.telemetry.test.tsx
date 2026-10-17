// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SimulationViewer } from "./SimulationViewer";

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Session creation is deferred by a macrotask (Strict Mode safety). */
const tick = () => act(async () => new Promise((done) => setTimeout(done, 0)));

const okFetch = () =>
  vi.fn().mockImplementation(async () => Response.json({ sessionId: "s" }));

const sessionOpens = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls.filter(([url]) => url === "/api/simulations/sim/sessions");

it("closes a session created after unmount with the actual dwell time and a rejected-beacon fallback", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let resolve!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(new Response());
  vi.stubGlobal("fetch", fetcher);
  const beacon = vi.fn().mockReturnValue(false);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <SimulationViewer
        simulationId="sim"
        title="Simulation"
        telemetry={{ surface: "results_page" }}
      />,
    ),
  );
  await tick();
  now = 1800;
  await act(async () => root.unmount());
  expect(beacon).not.toHaveBeenCalled();
  now = 4000;
  await act(async () => resolve(Response.json({ sessionId: "session" })));
  expect(beacon).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const [url, options] = fetcher.mock.calls[1];
  expect(url).toBe("/api/simulations/sim/sessions/session");
  expect(options.keepalive).toBe(true);
  expect(JSON.parse(options.body)).toMatchObject({ ended: true, dwellMs: 800 });
});

it("labels the session with its launch surface and the viewport at launch", async () => {
  vi.stubGlobal("innerWidth", 500);
  const fetcher = okFetch();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("navigator", { sendBeacon: vi.fn().mockReturnValue(true) });
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <SimulationViewer
        simulationId="sim"
        title="Simulation"
        telemetry={{ surface: "library" }}
      />,
    ),
  );
  await tick();
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe("/api/simulations/sim/sessions");
  expect(options.method).toBe("POST");
  expect(JSON.parse(options.body)).toEqual({
    attemptId: null,
    surface: "library",
    viewport: "phone",
  });
  await act(async () => root.unmount());
});

it("opens a new session per mount and records nothing without telemetry", async () => {
  const fetcher = okFetch();
  vi.stubGlobal("fetch", fetcher);
  const beacon = vi.fn().mockReturnValue(true);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
  const root = createRoot(document.createElement("div"));
  const view = (key: string) => (
    <SimulationViewer
      key={key}
      simulationId="sim"
      title="Simulation"
      telemetry={{ surface: "quiz_results", attemptId: "attempt-1" }}
    />
  );
  await act(async () => root.render(view("first")));
  await tick();
  await act(async () => root.render(view("second")));
  await tick();
  expect(sessionOpens(fetcher)).toHaveLength(2);
  // The first mount's cleanup sent its final batch when it was replaced.
  expect(beacon).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  expect(beacon).toHaveBeenCalledTimes(2);

  fetcher.mockClear();
  const staff = createRoot(document.createElement("div"));
  await act(async () =>
    staff.render(<SimulationViewer simulationId="sim" title="Simulation" />),
  );
  await tick();
  await act(async () => staff.unmount());
  expect(fetcher).not.toHaveBeenCalled();
});

it("records exactly one session per open under React Strict Mode", async () => {
  const fetcher = okFetch();
  vi.stubGlobal("fetch", fetcher);
  const beacon = vi.fn().mockReturnValue(true);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <StrictMode>
        <SimulationViewer
          simulationId="sim"
          title="Simulation"
          telemetry={{ surface: "results_page", attemptId: "a1" }}
        />
      </StrictMode>,
    ),
  );
  await tick();
  expect(sessionOpens(fetcher)).toHaveLength(1);
  // The simulated unmount ended nothing: no session existed yet.
  expect(beacon).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  expect(beacon).toHaveBeenCalledOnce();
});

it("forwards Escape from its own iframe only", async () => {
  vi.stubGlobal("fetch", okFetch());
  const host = document.createElement("div");
  document.body.appendChild(host);
  const onEscape = vi.fn();
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SimulationViewer
        simulationId="sim"
        title="Simulation"
        onEscape={onEscape}
      />,
    ),
  );
  const frame = host.querySelector("iframe")!;
  const post = (data: unknown, source: MessageEventSource | null) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent("message", { data, source }));
    });
  await post({ type: "sim-escape" }, window);
  await post({ type: "sim-telemetry" }, frame.contentWindow);
  expect(onEscape).not.toHaveBeenCalled();
  await post({ type: "sim-escape" }, frame.contentWindow);
  expect(onEscape).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  host.remove();
});
