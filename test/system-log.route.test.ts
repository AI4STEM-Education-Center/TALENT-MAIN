import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as LOGS } from "@/app/api/admin/logs/route";
import { logSystemEvent, logApiError } from "@/lib/system-log";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./db";

const mockAuth = vi.mocked(auth);

function asAdmin() {
  mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } } as never);
}

function logsRequest(query = "") {
  return new NextRequest(`http://localhost/api/admin/logs${query}`);
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("logSystemEvent", () => {
  it("persists a row with defaults and serialized metadata", async () => {
    await logSystemEvent({
      category: "AUTH",
      type: "LOGIN_FAILED",
      severity: "WARNING",
      message: "Failed login",
      ip: "1.2.3.4",
      metadata: { identifier: "someone", reason: "unknown_user" },
    });

    const row = await prisma.systemLog.findFirstOrThrow();
    expect(row.category).toBe("AUTH");
    expect(row.type).toBe("LOGIN_FAILED");
    expect(row.severity).toBe("WARNING");
    expect(row.ip).toBe("1.2.3.4");
    expect(JSON.parse(row.metadata!)).toEqual({
      identifier: "someone",
      reason: "unknown_user",
    });
  });

  it("defaults severity to INFO and caps the message length", async () => {
    await logSystemEvent({
      category: "SYSTEM",
      type: "T",
      message: "x".repeat(5000),
    });
    const row = await prisma.systemLog.findFirstOrThrow();
    expect(row.severity).toBe("INFO");
    expect(row.message.length).toBe(2000);
  });

  it("never throws on a failed write", async () => {
    const spy = vi.spyOn(prisma.systemLog, "create").mockRejectedValueOnce(new Error("db down"));
    await expect(
      logSystemEvent({ category: "SYSTEM", type: "T", message: "m" })
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("logApiError", () => {
  it("persists an API ERROR row keyed by the route tag", async () => {
    logApiError("SOME_ROUTE", new Error("boom"), "While testing");
    // Fire-and-forget write; give the microtask a beat to land.
    await vi.waitFor(async () => {
      expect(await prisma.systemLog.count()).toBe(1);
    });

    const row = await prisma.systemLog.findFirstOrThrow();
    expect(row.category).toBe("API");
    expect(row.type).toBe("SOME_ROUTE");
    expect(row.severity).toBe("ERROR");
    expect(row.message).toBe("While testing: boom");
    expect(JSON.parse(row.metadata!).stack).toContain("Error: boom");
  });
});

describe("GET /api/admin/logs", () => {
  it("401s a non-admin", async () => {
    mockAuth.mockResolvedValue({ user: { id: "t", role: "TEACHER" } } as never);
    expect((await LOGS(logsRequest())).status).toBe(401);
  });

  it("returns newest-first logs with pagination and a 24h summary", async () => {
    await logSystemEvent({ category: "AUTH", type: "LOGIN_FAILED", severity: "WARNING", message: "bad login" });
    await logSystemEvent({ category: "API", type: "SOME_ROUTE", severity: "ERROR", message: "boom" });
    await logSystemEvent({
      category: "USAGE",
      type: "USAGE_SAMPLE",
      message: "10 request(s)",
      metadata: { requests: 10, uniqueIps: 3 },
    });

    asAdmin();
    const body = await (await LOGS(logsRequest("?page=1&pageSize=2"))).json();
    expect(body.total).toBe(3);
    expect(body.logs).toHaveLength(2);
    expect(body.logs.map((l: { type: string }) => l.type)).toEqual([
      "USAGE_SAMPLE",
      "SOME_ROUTE",
    ]);
    expect(body.summary.errors24h).toBe(1);
    expect(body.summary.warnings24h).toBe(1);
    expect(body.summary.failedLogins24h).toBe(1);
    expect(body.summary.lastUsage.type).toBe("USAGE_SAMPLE");
  });

  it("filters by category, severity, and free text", async () => {
    await logSystemEvent({ category: "AUTH", type: "LOGIN_FAILED", severity: "WARNING", message: "bad login" });
    await logSystemEvent({ category: "API", type: "SOME_ROUTE", severity: "ERROR", message: "boom" });

    asAdmin();
    const byCategory = await (await LOGS(logsRequest("?category=AUTH"))).json();
    expect(byCategory.total).toBe(1);
    expect(byCategory.logs[0].type).toBe("LOGIN_FAILED");

    const bySeverity = await (await LOGS(logsRequest("?severity=ERROR"))).json();
    expect(bySeverity.total).toBe(1);
    expect(bySeverity.logs[0].type).toBe("SOME_ROUTE");

    const byText = await (await LOGS(logsRequest("?q=boom"))).json();
    expect(byText.total).toBe(1);
    expect(byText.logs[0].message).toBe("boom");
  });
});
