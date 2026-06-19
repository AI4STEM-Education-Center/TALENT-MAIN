import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, PUT } from "@/app/api/admin/backup/route";
import { POST as TEST } from "@/app/api/admin/backup/test/route";
import { POST as RUN } from "@/app/api/admin/backup/run/route";
import { GET as LIST } from "@/app/api/admin/backup/list/route";
import { POST as RESTORE } from "@/app/api/admin/backup/restore/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const mockAuth = vi.mocked(auth);
const asAdmin = () => mockAuth.mockResolvedValue({ user: { id: "a", role: "ADMIN" } } as never);
const asTeacher = () => mockAuth.mockResolvedValue({ user: { id: "t", role: "TEACHER" } } as never);

function putReq(body: unknown) {
  return new Request("http://test/api/admin/backup", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function restoreReq(body: unknown) {
  return new Request("http://test/api/admin/backup/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await prisma.backupConfig.deleteMany();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.backupConfig.deleteMany();
  await prisma.$disconnect();
});

describe("admin backup routes — auth gating", () => {
  it("403s a non-admin on every route", async () => {
    asTeacher();
    expect((await GET()).status).toBe(403);
    expect((await PUT(putReq({}))).status).toBe(403);
    expect((await TEST()).status).toBe(403);
    expect((await RUN()).status).toBe(403);
    expect((await LIST()).status).toBe(403);
    expect((await RESTORE(restoreReq({ name: "x" }))).status).toBe(403);
  });
});

describe("GET/PUT /api/admin/backup", () => {
  it("returns a null config initially", async () => {
    asAdmin();
    const body = await (await GET()).json();
    expect(body.config).toBeNull();
    expect(body.appEnv).toBeTruthy();
  });

  it("upserts config, normalizes baseDir, and masks the stored password", async () => {
    asAdmin();
    const res = await PUT(
      putReq({
        webdavUrl: "https://dav.example/files",
        webdavUsername: "alice",
        password: "supersecret",
        baseDir: "backups",
        enabled: true,
        intervalHours: 24,
        anchorTime: "02:00",
        timezone: "America/New_York",
        keepRecent: 5,
        keepWeekly: 3,
        keepMonthly: 6,
        keepYearly: 2,
      }),
    );
    expect(res.status).toBe(200);
    const saved = (await res.json()).config;
    expect(saved.webdavUrl).toBe("https://dav.example/files");
    expect(saved.baseDir).toBe("/backups");
    expect(saved.hasPassword).toBe(true);

    const after = (await (await GET()).json()).config;
    expect(after.maskedPassword).toMatch(/^••••/);
    expect(after.maskedPassword).not.toContain("supersecret");
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt).toBeTruthy();
  });

  it("preserves the saved password when re-sent as the masked placeholder", async () => {
    asAdmin();
    await PUT(putReq({ webdavUrl: "https://dav.example/files", password: "keepme", enabled: false }));
    await PUT(putReq({ webdavUrl: "https://dav.example/files", password: "••••••••", enabled: false }));
    const after = (await (await GET()).json()).config;
    expect(after.hasPassword).toBe(true);
  });

  it("rejects enabling without a WebDAV URL", async () => {
    asAdmin();
    const res = await PUT(putReq({ enabled: true }));
    expect(res.status).toBe(400);
  });
});

describe("restore validation", () => {
  it("rejects a malformed backup name", async () => {
    asAdmin();
    const res = await RESTORE(restoreReq({ name: "../etc/passwd" }));
    expect(res.status).toBe(400);
  });
});
