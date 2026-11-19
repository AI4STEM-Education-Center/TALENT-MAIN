import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSttSettingsCache } from "@/lib/stt/config";
import { GET, PUT } from "@/app/api/admin/stt/route";
import { createAdmin, resetDb } from "./db";

beforeEach(async () => {
  vi.unstubAllEnvs();
  await resetDb();
  invalidateSttSettingsCache();
  const admin = await createAdmin();
  vi.mocked(auth).mockResolvedValue({
    user: { id: admin.id, role: "ADMIN" },
  } as never);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("admin STT card response contract", () => {
  it("returns empty arrays and deployment status consumed by the card", async () => {
    vi.stubEnv("AWS_REGION", " eu-west-1 ");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/stt"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      settings: { region: "", languageOptions: ["en-US", "zh-CN"] },
      effectiveRegion: "eu-west-1",
      hasCredentials: true,
      usage: {
        totalSessions: 0,
        totalDurationMs: 0,
        uniqueUsers: 0,
        recentSessions: [],
        userSummaries: [],
      },
    });
  });

  it("returns refreshed region and credential status after saving", async () => {
    vi.stubEnv("AWS_REGION", "eu-west-1");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", " ");
    const response = await PUT(
      new Request("http://localhost/api/admin/stt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { region: "us-west-2" } }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      settings: { region: "us-west-2" },
      effectiveRegion: "us-west-2",
      hasCredentials: false,
    });
    const get = await GET(new NextRequest("http://localhost/api/admin/stt"));
    expect(await get.json()).toMatchObject({
      effectiveRegion: "us-west-2",
      hasCredentials: false,
    });
  });

  it("does not advertise a fallback region that the presigner cannot use", async () => {
    vi.stubEnv("AWS_REGION", "");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/stt"),
    );
    expect(await response.json()).toMatchObject({
      effectiveRegion: "",
    });
  });
});
