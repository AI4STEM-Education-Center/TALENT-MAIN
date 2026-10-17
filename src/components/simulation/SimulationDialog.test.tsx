// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SimulationDialog } from "./SimulationDialog";

let root: Root;
let host: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;
let beacon: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  fetcher = vi
    .fn()
    .mockImplementation(async () => Response.json({ sessionId: "s" }));
  beacon = vi.fn().mockReturnValue(true);
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A launcher like the rail/library: the dialog renders only while open. */
function Launcher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="launch" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <SimulationDialog
          simulation={{ simulationId: "sim", title: "Pendulum", version: 2 }}
          onClose={() => setOpen(false)}
          description="How length sets the period"
          context="Forces · Physics"
          footer={<p>Rate this</p>}
          telemetry={{ surface: "library", classId: "class-1" }}
        />
      )}
    </>
  );
}

const sessionOpens = () =>
  fetcher.mock.calls.filter(([url]) => url === "/api/simulations/sim/sessions");
const dialog = () => document.querySelector('[role="dialog"]');
const launch = () =>
  act(async () =>
    (host.querySelector('[data-testid="launch"]') as HTMLElement).click(),
  );

it("renders the simulation with its header context and footer in a modal", async () => {
  await act(async () => root.render(<Launcher />));
  expect(dialog()).toBeNull();
  await launch();
  const el = dialog()!;
  expect(el).not.toBeNull();
  expect(el.textContent).toContain("Pendulum");
  expect(el.textContent).toContain("How length sets the period");
  expect(el.textContent).toContain("Forces · Physics");
  expect(el.textContent).toContain("Rate this");
  const frame = el.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toBe("/api/simulations/sim/content?v=2");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
});

it("ignores outside clicks but closes on Escape, ending the session", async () => {
  await act(async () => root.render(<Launcher />));
  await launch();
  // Radix registers its outside-pointer listener on the next tick.
  await act(async () => new Promise((done) => setTimeout(done, 0)));
  await act(async () => {
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(dialog()).not.toBeNull();
  expect(beacon).not.toHaveBeenCalled();

  await act(async () => {
    dialog()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(dialog()).toBeNull();
  expect(beacon).toHaveBeenCalledOnce();
  expect(beacon.mock.calls[0][0]).toBe("/api/simulations/sim/sessions/s");
});

it("records one session per open", async () => {
  await act(async () => root.render(<Launcher />));
  await launch();
  const close = () =>
    act(async () =>
      (dialog()!.querySelector("button:last-of-type") as HTMLElement).click(),
    );
  await close();
  expect(dialog()).toBeNull();
  await launch();
  await close();
  expect(sessionOpens()).toHaveLength(2);
  expect(beacon).toHaveBeenCalledTimes(2);
  for (const [, options] of sessionOpens()) {
    expect(JSON.parse(options.body)).toMatchObject({
      surface: "library",
      classId: "class-1",
    });
  }
});
