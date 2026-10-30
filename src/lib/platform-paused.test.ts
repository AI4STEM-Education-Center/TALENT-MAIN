// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  isPlatformPausedBody,
  redirectIfPlatformPaused,
  PLATFORM_PAUSED_CODE,
} from "./platform-paused";

const assign = vi.fn();
afterEach(() => {
  assign.mockClear();
  vi.unstubAllGlobals();
});
function stubLocation(pathname: string) {
  vi.stubGlobal("location", { pathname, assign });
}
const paused = () =>
  Response.json({ error: "x", code: PLATFORM_PAUSED_CODE }, { status: 403 });

it("recognises the paused body", () => {
  expect(isPlatformPausedBody({ code: PLATFORM_PAUSED_CODE })).toBe(true);
  expect(isPlatformPausedBody({ code: "OTHER" })).toBe(false);
  expect(isPlatformPausedBody(null)).toBe(false);
});

it("navigates to the paused page on the paused 403 and leaves the body readable", async () => {
  stubLocation("/student/classes");
  const res = paused();
  expect(await redirectIfPlatformPaused(res)).toBe(true);
  expect(assign).toHaveBeenCalledWith("/student/paused");
  expect((await res.json()).code).toBe(PLATFORM_PAUSED_CODE);
});

it("ignores other 403s, other statuses and the paused page itself", async () => {
  stubLocation("/student");
  expect(
    await redirectIfPlatformPaused(
      Response.json({ error: "no" }, { status: 403 }),
    ),
  ).toBe(false);
  expect(
    await redirectIfPlatformPaused(Response.json({}, { status: 200 })),
  ).toBe(false);
  stubLocation("/student/paused");
  await redirectIfPlatformPaused(paused());
  expect(assign).not.toHaveBeenCalled();
});
