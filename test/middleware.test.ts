import { describe, it, expect, vi } from "vitest";

// proxy.ts default-exports `auth((req) => ...)`. Mock the NextAuth wrapper so it
// returns the inner handler untouched, letting us call the routing logic directly.
vi.mock("@/lib/auth", () => ({ auth: (handler: unknown) => handler }));

import middleware from "@/proxy";

type Session = { user?: { role?: string } } | null;

function makeReq({
  host,
  path,
  session = null,
  proto = "https",
}: {
  host: string;
  path: string;
  session?: Session;
  proto?: string;
}) {
  const url = `${proto}://${host}${path}`;
  const headers = new Map<string, string>([["host", host]]);
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    nextUrl: { pathname: path },
    auth: session,
    url,
  } as never;
}

// middleware is the unwrapped handler thanks to the mock above.
const run = (req: ReturnType<typeof makeReq>) => (middleware as unknown as (r: never) => Response)(req);

describe("middleware host validation", () => {
  it("forbids an unknown host", () => {
    const res = run(makeReq({ host: "evil.com", path: "/" }));
    expect(res.status).toBe(403);
  });

  it("allows the apex ai4talent.org and its subdomains", () => {
    expect(run(makeReq({ host: "ai4talent.org", path: "/" })).status).not.toBe(403);
    expect(run(makeReq({ host: "dev.ai4talent.org", path: "/" })).status).not.toBe(403);
  });

  it("allows localhost", () => {
    expect(run(makeReq({ host: "localhost:3000", path: "/" })).status).not.toBe(403);
  });
});

describe("middleware auth + routing", () => {
  it("lets anonymous users hit public routes", () => {
    const res = run(makeReq({ host: "localhost", path: "/login" }));
    expect(res.headers.get("location")).toBeNull(); // NextResponse.next()
  });

  it("lets anonymous users reach the password recovery pages", () => {
    for (const path of ["/forgot-password", "/reset-password"]) {
      expect(run(makeReq({ host: "localhost", path })).headers.get("location")).toBeNull();
    }
  });

  it("treats the password reset API as public (it lives under /api/auth)", () => {
    for (const path of ["/api/auth/forgot-password", "/api/auth/reset-password"]) {
      expect(run(makeReq({ host: "localhost", path })).headers.get("location")).toBeNull();
    }
  });

  it("treats the invitations API as public", () => {
    const res = run(makeReq({ host: "localhost", path: "/api/invitations/abc" }));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects anonymous users away from protected routes to /login", () => {
    const res = run(makeReq({ host: "dev.ai4talent.org", path: "/teacher" }));
    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/login");
    expect(location).toContain("callbackUrl=%2Fteacher");
  });

  it("redirects a STUDENT away from /teacher to /student", () => {
    const res = run(
      makeReq({ host: "dev.ai4talent.org", path: "/teacher", session: { user: { role: "STUDENT" } } })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/student");
  });

  it("redirects a TEACHER away from /student to /teacher", () => {
    const res = run(
      makeReq({ host: "dev.ai4talent.org", path: "/student", session: { user: { role: "TEACHER" } } })
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/teacher");
  });

  it("lets a TEACHER through to a teacher route", () => {
    const res = run(
      makeReq({ host: "dev.ai4talent.org", path: "/teacher", session: { user: { role: "TEACHER" } } })
    );
    expect(res.headers.get("location")).toBeNull();
  });
});
