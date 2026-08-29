import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, PUT } from "@/app/api/admin/guardrails/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getGuardrailSettings,
  invalidateGuardrailSettings,
  defaultGuardrailSettings,
} from "@/lib/guardrail-settings";
import { resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const asAdmin = () =>
  mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } } as never);
const asTeacher = () =>
  mockAuth.mockResolvedValue({ user: { id: "t-1", role: "TEACHER" } } as never);

const BASE = "http://localhost/api/admin/guardrails";

function putReq(body: unknown) {
  return new Request(BASE, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  invalidateGuardrailSettings();
  asAdmin();
});

describe("GET /api/admin/guardrails", () => {
  it("returns the shipped defaults when no row exists", async () => {
    const body = await (await GET()).json();
    expect(body.settings).toEqual(defaultGuardrailSettings());
  });

  it("returns the surface catalog and bounds the form renders from", async () => {
    const body = await (await GET()).json();
    expect(body.surfaces.length).toBeGreaterThan(0);
    expect(body.surfaces[0]).toHaveProperty("key");
    expect(body.surfaces[0]).toHaveProperty("label");
    expect(body.thresholdBounds).toEqual({ min: 0, max: 1 });
    expect(body.defaultTopicDescription).toContain("STEM");
  });

  it("is admin-only", async () => {
    asTeacher();
    expect((await GET()).status).toBe(403);
    mockAuth.mockResolvedValue(null as never);
    expect((await GET()).status).toBe(403);
  });
});

describe("PUT /api/admin/guardrails", () => {
  it("saves settings and reads them back", async () => {
    const res = await PUT(
      putReq({
        moderationEnabled: false,
        jailbreakMode: "BLOCK",
        offTopicMode: "FLAG",
        jailbreakThreshold: 0.8,
        offTopicThreshold: 0.6,
        topicDescription: "Only physics",
        failOpen: false,
        disabledSurfaces: ["assistant_reply"],
      })
    );
    expect(res.status).toBe(200);

    invalidateGuardrailSettings();
    const stored = await getGuardrailSettings();
    expect(stored).toEqual({
      moderationEnabled: false,
      jailbreakMode: "BLOCK",
      offTopicMode: "FLAG",
      jailbreakThreshold: 0.8,
      offTopicThreshold: 0.6,
      topicDescription: "Only physics",
      failOpen: false,
      disabledSurfaces: ["assistant_reply"],
    });
  });

  it("upserts rather than creating a second row", async () => {
    await PUT(putReq({ jailbreakMode: "BLOCK" }));
    await PUT(putReq({ jailbreakMode: "OFF" }));

    expect(await prisma.guardrailConfig.count()).toBe(1);
    invalidateGuardrailSettings();
    expect((await getGuardrailSettings()).jailbreakMode).toBe("OFF");
  });

  it("normalizes hostile input server-side rather than trusting the form", async () => {
    const body = await (
      await PUT(
        putReq({
          jailbreakMode: "ALLOW_EVERYTHING",
          jailbreakThreshold: 99,
          disabledSurfaces: ["nope"],
          topicDescription: "y".repeat(9_000),
        })
      )
    ).json();

    expect(body.settings.jailbreakMode).toBe("FLAG");
    expect(body.settings.jailbreakThreshold).toBe(1);
    expect(body.settings.disabledSurfaces).toEqual([]);
    expect(body.settings.topicDescription).toHaveLength(2_000);
  });

  it("rejects a malformed body", async () => {
    expect((await PUT(putReq("not json"))).status).toBe(400);
  });

  it("is admin-only", async () => {
    asTeacher();
    expect((await PUT(putReq({ jailbreakMode: "OFF" }))).status).toBe(403);
    expect(await prisma.guardrailConfig.count()).toBe(0);
  });

  it("saving invalidates the cache, so the next read is not stale", async () => {
    // Warm the cache with the defaults.
    expect((await getGuardrailSettings()).jailbreakMode).toBe("FLAG");
    // No manual invalidation here — saveGuardrailSettings must do it.
    await PUT(putReq({ jailbreakMode: "BLOCK" }));
    expect((await getGuardrailSettings()).jailbreakMode).toBe("BLOCK");
  });
});
