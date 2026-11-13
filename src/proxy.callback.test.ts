import { describe, expect, it, vi } from "vitest";

// proxy.ts default-exports `auth((req) => ...)`; return the inner handler.
vi.mock("@/lib/auth", () => ({ auth: (handler: unknown) => handler }));
vi.mock("@/lib/class-access-guard", () => ({
  guardStudentClassAccess: vi.fn(async () => null),
}));

import proxy from "@/proxy";
import { safeRelativeCallbackUrl } from "@/lib/safe-callback-url";

type Session = {
  user?: { role?: string; consentDecision?: string | null };
} | null;

function makeReq(path: string, session: Session = null) {
  const url = new URL(`https://localhost${path}`);
  const headers = new Map<string, string>([
    ["host", "localhost"],
    ["accept", "text/html"],
  ]);
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    nextUrl: { pathname: url.pathname, search: url.search },
    method: "GET",
    auth: session,
    url: url.toString(),
  } as never;
}

const run = (req: ReturnType<typeof makeReq>) =>
  (proxy as unknown as (r: never) => Promise<Response>)(req);

const callbackOf = async (req: ReturnType<typeof makeReq>) => {
  const location = (await run(req)).headers.get("location");
  expect(location).not.toBeNull();
  const target = new URL(location!);
  return {
    path: target.pathname,
    callback: target.searchParams.get("callbackUrl"),
  };
};

describe("proxy callback preservation", () => {
  it("keeps the query string when sending a signed-out user to login", async () => {
    const { path, callback } = await callbackOf(
      makeReq("/teacher/quizzes/q1/versions/b1?slot=2&tab=review"),
    );
    expect(path).toBe("/login");
    expect(callback).toBe("/teacher/quizzes/q1/versions/b1?slot=2&tab=review");
  });

  it("keeps a bare path unchanged when there is no query string", async () => {
    expect((await callbackOf(makeReq("/teacher"))).callback).toBe("/teacher");
  });

  it("returns an unconsented teacher to the requested page after consent", async () => {
    const { path, callback } = await callbackOf(
      makeReq("/teacher/quizzes/q1/versions/b1?batchId=abc", {
        user: { role: "TEACHER", consentDecision: null },
      }),
    );
    expect(path).toBe("/teacher/consent-required");
    expect(callback).toBe("/teacher/quizzes/q1/versions/b1?batchId=abc");
  });

  it("does not gate the consent page itself", async () => {
    const res = await run(
      makeReq("/teacher/consent-required?callbackUrl=%2Fteacher", {
        user: { role: "TEACHER", consentDecision: null },
      }),
    );
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("safeRelativeCallbackUrl", () => {
  it("accepts same-origin relative paths with their query strings", () => {
    expect(safeRelativeCallbackUrl("/teacher/quizzes?x=1")).toBe(
      "/teacher/quizzes?x=1",
    );
  });

  it.each([
    "https://evil.example/phish",
    "//evil.example/phish",
    "/\\evil.example",
    "javascript:alert(1)",
    "teacher",
    "",
    null,
    undefined,
  ])("rejects open-redirect target %s", (value) => {
    expect(safeRelativeCallbackUrl(value)).toBeUndefined();
  });
});
