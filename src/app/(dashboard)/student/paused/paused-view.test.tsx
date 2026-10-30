// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const replace = vi.fn();
const signOut = vi.fn(async (_opts?: unknown) => undefined);
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("next-auth/react", () => ({
  signOut: (opts?: unknown) => signOut(opts),
}));

import { PausedView, POLL_INTERVAL_MS } from "./paused-view";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  replace.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = () =>
  act(async () => root.render(<PausedView message="Back Monday" />));

it("shows the message and a sign-out button", async () => {
  await render();
  expect(host.textContent).toContain("Back Monday");
  const btn = host.querySelector("button")!;
  expect(btn.textContent).toContain("Sign out");
});

it("polls and returns to the dashboard once access is restored", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ paused: true, message: "Still" }))
    .mockResolvedValueOnce(Response.json({ paused: false, message: null }));
  vi.stubGlobal("fetch", fetchMock);
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/student/access",
    expect.anything(),
  );
  expect(host.textContent).toContain("Still");
  expect(replace).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  });
  expect(replace).toHaveBeenCalledWith("/student");
});

it("also checks when the window regains focus", async () => {
  const fetchMock = vi.fn(async () => Response.json({ paused: false }));
  vi.stubGlobal("fetch", fetchMock);
  await render();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(replace).toHaveBeenCalledWith("/student");
});
