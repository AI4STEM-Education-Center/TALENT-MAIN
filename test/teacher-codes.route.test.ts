import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, POST } from "@/app/api/admin/teacher-codes/route";
import { PATCH, DELETE } from "@/app/api/admin/teacher-codes/[id]/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MAX_USES_LIMIT, normalizeTeacherCode } from "@/lib/teacher-codes";
import { resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const asAdmin = () => mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } } as never);
const asTeacher = () => mockAuth.mockResolvedValue({ user: { id: "t-1", role: "TEACHER" } } as never);

const BASE = "http://localhost/api/admin/teacher-codes";

function listReq() {
  return new NextRequest(BASE);
}

function createReq(body: unknown) {
  return new NextRequest(BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchReq(id: string, body: unknown) {
  return new NextRequest(`${BASE}/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  delete process.env.TEACHER_SIGNUP_TOKEN;
  asAdmin();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("/api/admin/teacher-codes", () => {
  it("refuses every verb to a non-admin", async () => {
    asTeacher();
    expect((await GET(listReq())).status).toBe(403);
    expect((await POST(createReq({}))).status).toBe(403);
    expect((await PATCH(patchReq("x", { active: false }), params("x"))).status).toBe(403);
    expect((await DELETE(new NextRequest(`${BASE}/x`, { method: "DELETE" }), params("x"))).status).toBe(403);
  });

  it("issues a code with no duration and no use limit", async () => {
    const res = await POST(createReq({}));
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.expiresAt).toBeNull();
    expect(body.maxUses).toBeNull();
    expect(body.usedCount).toBe(0);
    expect(body.status).toBe("ACTIVE");
    expect(body.label).toBeNull();
    // Shown in display form; the link carries the stored form.
    expect(body.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(body.url).toMatch(
      new RegExp(`^https?://[^/]+/register\\?code=${normalizeTeacherCode(body.code)}$`)
    );

    const row = await prisma.teacherRegistrationCode.findFirst();
    expect(row?.code).toBe(normalizeTeacherCode(body.code));
    expect(row?.createdById).toBe("admin-1");
  });

  it("stores the requested duration and use limit", async () => {
    const before = Date.now();
    const res = await POST(
      createReq({ label: "  Fall 2026 TAs  ", expiresInMinutes: 120, maxUses: 3 })
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.label).toBe("Fall 2026 TAs");
    expect(body.maxUses).toBe(3);
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 120 * 60_000);
    expect(expiresAt).toBeLessThan(before + 121 * 60_000);
  });

  it("rejects a duration or use limit outside its bounds, naming the bound", async () => {
    const tooShort = await POST(createReq({ expiresInMinutes: 1 }));
    expect(tooShort.status).toBe(400);
    expect((await tooShort.json()).error).toMatch(/5 minutes/);

    const tooLong = await POST(createReq({ expiresInMinutes: 6 * 365 * 24 * 60 }));
    expect(tooLong.status).toBe(400);

    const tooManyUses = await POST(createReq({ maxUses: MAX_USES_LIMIT + 1 }));
    expect(tooManyUses.status).toBe(400);
    expect((await tooManyUses.json()).error).toMatch(/use limit/i);

    const zeroUses = await POST(createReq({ maxUses: 0 }));
    expect(zeroUses.status).toBe(400);

    expect(await prisma.teacherRegistrationCode.count()).toBe(0);
  });

  it("rejects a non-integer duration as a shape error", async () => {
    expect((await POST(createReq({ expiresInMinutes: 10.5 }))).status).toBe(400);
    expect((await POST(createReq({ maxUses: "3" }))).status).toBe(400);
  });

  it("lists codes newest-first with their computed status", async () => {
    const first = await (await POST(createReq({ label: "first", maxUses: 1 }))).json();
    const second = await (await POST(createReq({ label: "second" }))).json();
    // Exhaust the first one so the list has to report a non-ACTIVE status, and
    // date it back so the newest-first ordering isn't a same-millisecond tie.
    await prisma.teacherRegistrationCode.update({
      where: { id: first.id },
      data: { usedCount: 1, createdAt: new Date(Date.now() - 60_000) },
    });

    const body = await (await GET(listReq())).json();
    expect(body.codes.map((c: { id: string }) => c.id)).toEqual([second.id, first.id]);
    expect(body.codes[0].status).toBe("ACTIVE");
    expect(body.codes[1].status).toBe("EXHAUSTED");
    expect(body.envTokenActive).toBe(false);
  });

  it("flags the legacy env token so the panel can warn about it", async () => {
    process.env.TEACHER_SIGNUP_TOKEN = "legacy";
    const body = await (await GET(listReq())).json();
    expect(body.envTokenActive).toBe(true);
  });

  it("revokes and restores a code without touching its usage count", async () => {
    const created = await (await POST(createReq({}))).json();
    await prisma.teacherRegistrationCode.update({
      where: { id: created.id },
      data: { usedCount: 2 },
    });

    const revoked = await (await PATCH(patchReq(created.id, { active: false }), params(created.id))).json();
    expect(revoked.active).toBe(false);
    expect(revoked.status).toBe("REVOKED");
    expect(revoked.usedCount).toBe(2);

    const restored = await (await PATCH(patchReq(created.id, { active: true }), params(created.id))).json();
    expect(restored.status).toBe("ACTIVE");
    expect(restored.usedCount).toBe(2);
  });

  it("404s when revoking or deleting a code that does not exist", async () => {
    expect((await PATCH(patchReq("nope", { active: false }), params("nope"))).status).toBe(404);
    const del = await DELETE(new NextRequest(`${BASE}/nope`, { method: "DELETE" }), params("nope"));
    expect(del.status).toBe(404);
  });

  it("deletes a code for good", async () => {
    const created = await (await POST(createReq({}))).json();
    const res = await DELETE(
      new NextRequest(`${BASE}/${created.id}`, { method: "DELETE" }),
      params(created.id)
    );
    expect(res.status).toBe(200);
    expect(await prisma.teacherRegistrationCode.count()).toBe(0);
  });
});
