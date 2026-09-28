// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SimulationViewer } from "./SimulationViewer";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("closes a session created after unmount with the actual dwell time and a rejected-beacon fallback", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
        telemetry={{ surface: "rail" }}
      />,
    ),
  );
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
