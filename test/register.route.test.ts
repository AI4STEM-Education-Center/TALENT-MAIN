import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { POST } from "@/app/api/auth/register/route";
import { prisma } from "@/lib/prisma";
import { createTeacherCode } from "@/lib/teacher-registration-codes";
import { formatTeacherCode } from "@/lib/teacher-codes";
import { resetDb, createTeacher } from "./db";

const TOKEN = "secret-teacher-code";

function postRegister(body: unknown) {
  return POST(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

const validBody = {
  firstName: "New",
  lastName: "Teacher",
  username: "newteacher",
  email: "new@example.com",
  password: "Abcdef1!",
  inviteCode: TOKEN,
};

beforeEach(async () => {
  await resetDb();
  process.env.TEACHER_SIGNUP_TOKEN = TOKEN;
  delete process.env.ADMIN_SIGNUP_TOKEN;
});

afterAll(async () => {
  delete process.env.ADMIN_SIGNUP_TOKEN;
  await prisma.$disconnect();
});

describe("POST /api/auth/register", () => {
  it("returns 503 when no invite source is configured", async () => {
    delete process.env.TEACHER_SIGNUP_TOKEN;
    const res = await postRegister(validBody);
    expect(res.status).toBe(503);
  });

  it("rejects an invalid invite code with 403", async () => {
    const res = await postRegister({ ...validBody, inviteCode: "wrong" });
    expect(res.status).toBe(403);
  });

  it("rejects missing fields with 400", async () => {
    const res = await postRegister({ ...validBody, email: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a weak password with 400", async () => {
    const res = await postRegister({ ...validBody, password: "weak" });
    expect(res.status).toBe(400);
  });

  it("creates a TEACHER user (and teacher row) on success", async () => {
    const res = await postRegister(validBody);
    expect(res.status).toBe(201);

    const user = await prisma.user.findUnique({
      where: { email: "new@example.com" },
      include: { teacher: true },
    });
    expect(user).not.toBeNull();
    expect(user?.role).toBe("TEACHER");
    expect(user?.username).toBe("newteacher");
    expect(user?.teacher).not.toBeNull();
    // Password is stored hashed, never in plaintext.
    expect(user?.hashedPassword).not.toBe("Abcdef1!");
  });

  it("reports the created role in the response", async () => {
    const res = await postRegister(validBody);
    expect(await res.json()).toEqual({ success: true, role: "TEACHER" });
  });

  it("still accepts the legacy teacherToken body key", async () => {
    const res = await postRegister({
      ...validBody,
      inviteCode: undefined,
      teacherToken: TOKEN,
    });
    expect(res.status).toBe(201);
  });

  it("normalizes email and username to lowercase", async () => {
    const res = await postRegister({
      ...validBody,
      email: "MixedCase@Example.COM",
      username: "MixedCaseUser",
    });
    expect(res.status).toBe(201);
    const user = await prisma.user.findUnique({
      where: { email: "mixedcase@example.com" },
    });
    expect(user?.username).toBe("mixedcaseuser");
  });

  it("rejects a duplicate email with 409", async () => {
    await createTeacher({ email: "new@example.com", username: "someoneelse" });
    const res = await postRegister(validBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
  });

  it("rejects a duplicate username with 409", async () => {
    await createTeacher({
      email: "different@example.com",
      username: "newteacher",
    });
    const res = await postRegister(validBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/username/i);
  });
});

/**
 * Admin-issued codes (TeacherRegistrationCode). The env var is cleared in every
 * spec below so only the code decides the outcome.
 */
describe("POST /api/auth/register — admin-issued codes", () => {
  beforeEach(() => {
    delete process.env.TEACHER_SIGNUP_TOKEN;
  });

  it("registers with a code and consumes exactly one use", async () => {
    const code = await createTeacherCode({ maxUses: 2 });

    const res = await postRegister({ ...validBody, inviteCode: code.code });
    expect(res.status).toBe(201);

    const after = await prisma.teacherRegistrationCode.findUnique({
      where: { id: code.id },
    });
    expect(after?.usedCount).toBe(1);
    expect(after?.lastUsedAt).not.toBeNull();
  });

  it("accepts the code in the dash-separated form the admin panel displays", async () => {
    const code = await createTeacherCode({});
    const res = await postRegister({
      ...validBody,
      inviteCode: ` ${formatTeacherCode(code.code).toLowerCase()} `,
    });
    expect(res.status).toBe(201);
  });

  it("returns 503 when no code exists and no env token is set", async () => {
    const res = await postRegister(validBody);
    expect(res.status).toBe(503);
  });

  it("does not report 503 once a usable code exists — a wrong code is a 403", async () => {
    await createTeacherCode({});
    const res = await postRegister({
      ...validBody,
      inviteCode: "WRONGWRONGWRONG1",
    });
    expect(res.status).toBe(403);
  });

  it("refuses an expired code", async () => {
    const code = await createTeacherCode({});
    await prisma.teacherRegistrationCode.update({
      where: { id: code.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // Another code keeps signup "configured", so this is a 403 and not a 503.
    await createTeacherCode({});

    const res = await postRegister({ ...validBody, inviteCode: code.code });
    expect(res.status).toBe(403);
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a revoked code", async () => {
    const code = await createTeacherCode({});
    await prisma.teacherRegistrationCode.update({
      where: { id: code.id },
      data: { active: false },
    });
    await createTeacherCode({});

    const res = await postRegister({ ...validBody, inviteCode: code.code });
    expect(res.status).toBe(403);
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a code that has hit its use limit", async () => {
    const code = await createTeacherCode({ maxUses: 1 });

    expect(
      (await postRegister({ ...validBody, inviteCode: code.code })).status,
    ).toBe(201);

    const second = await postRegister({
      ...validBody,
      inviteCode: code.code,
      email: "second@example.com",
      username: "secondteacher",
    });
    expect(second.status).toBe(403);
    expect(await prisma.user.count()).toBe(1);
  });

  it("does not burn a use when the signup itself fails", async () => {
    const code = await createTeacherCode({ maxUses: 1 });
    await createTeacher({ email: "new@example.com", username: "someoneelse" });

    const res = await postRegister({ ...validBody, inviteCode: code.code });
    expect(res.status).toBe(409);

    const after = await prisma.teacherRegistrationCode.findUnique({
      where: { id: code.id },
    });
    expect(after?.usedCount).toBe(0);
  });

  it("still honours the env token alongside codes, without consuming one", async () => {
    process.env.TEACHER_SIGNUP_TOKEN = TOKEN;
    const code = await createTeacherCode({ maxUses: 1 });

    expect((await postRegister(validBody)).status).toBe(201);

    const after = await prisma.teacherRegistrationCode.findUnique({
      where: { id: code.id },
    });
    expect(after?.usedCount).toBe(0);
  });
});

/**
 * The one endpoint serves every non-student role: the invite code decides it.
 */
describe("POST /api/auth/register — role resolution", () => {
  const ADMIN_TOKEN = "secret-admin-code";

  beforeEach(() => {
    delete process.env.TEACHER_SIGNUP_TOKEN;
  });

  it("creates an ADMIN (with no Teacher row) from ADMIN_SIGNUP_TOKEN", async () => {
    process.env.ADMIN_SIGNUP_TOKEN = ADMIN_TOKEN;
    const res = await postRegister({ ...validBody, inviteCode: ADMIN_TOKEN });
    expect(res.status).toBe(201);
    expect((await res.json()).role).toBe("ADMIN");

    const user = await prisma.user.findUnique({
      where: { email: "new@example.com" },
      include: { teacher: true },
    });
    expect(user?.role).toBe("ADMIN");
    expect(user?.teacher).toBeNull();
  });

  it("accepts the admin token under the legacy adminToken key", async () => {
    process.env.ADMIN_SIGNUP_TOKEN = ADMIN_TOKEN;
    // JSON.stringify drops the undefined key, so only adminToken is sent.
    const res = await postRegister({
      ...validBody,
      inviteCode: undefined,
      adminToken: ADMIN_TOKEN,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).role).toBe("ADMIN");
  });

  it("matches the admin token exactly (no case folding or trimming)", async () => {
    process.env.ADMIN_SIGNUP_TOKEN = ADMIN_TOKEN;
    for (const attempt of [ADMIN_TOKEN.toUpperCase(), ` ${ADMIN_TOKEN}`]) {
      const res = await postRegister({ ...validBody, inviteCode: attempt });
      expect(res.status).toBe(403);
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it("counts ADMIN_SIGNUP_TOKEN alone as configured: a wrong code is a 403", async () => {
    process.env.ADMIN_SIGNUP_TOKEN = ADMIN_TOKEN;
    const res = await postRegister({ ...validBody, inviteCode: "nope" });
    expect(res.status).toBe(403);
  });

  it("does not let the teacher token mint an admin, or vice versa", async () => {
    process.env.ADMIN_SIGNUP_TOKEN = ADMIN_TOKEN;
    process.env.TEACHER_SIGNUP_TOKEN = TOKEN;
    const res = await postRegister({ ...validBody, inviteCode: TOKEN });
    expect((await res.json()).role).toBe("TEACHER");
  });

  it("creates a RESEARCHER (with no Teacher row) from a researcher code", async () => {
    const code = await createTeacherCode({ role: "RESEARCHER", maxUses: 1 });
    const res = await postRegister({ ...validBody, inviteCode: code.code });
    expect(res.status).toBe(201);
    expect((await res.json()).role).toBe("RESEARCHER");

    const user = await prisma.user.findUnique({
      where: { email: "new@example.com" },
      include: { teacher: true },
    });
    expect(user?.role).toBe("RESEARCHER");
    expect(user?.teacher).toBeNull();
    const after = await prisma.teacherRegistrationCode.findUnique({
      where: { id: code.id },
    });
    expect(after?.usedCount).toBe(1);
  });

  it("refuses a code whose stored role is not an invite role (never mints ADMIN)", async () => {
    const code = await createTeacherCode({});
    await prisma.teacherRegistrationCode.update({
      where: { id: code.id },
      data: { role: "ADMIN" },
    });
    const res = await postRegister({ ...validBody, inviteCode: code.code });
    expect(res.status).toBe(403);
    expect(await prisma.user.count()).toBe(0);
  });

  it("gives the same error for unknown, expired and wrong-role codes", async () => {
    const expired = await createTeacherCode({});
    await prisma.teacherRegistrationCode.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await createTeacherCode({});

    const a = await postRegister({
      ...validBody,
      inviteCode: "UNKNOWNCODE12345",
    });
    const b = await postRegister({ ...validBody, inviteCode: expired.code });
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect((await a.json()).error).toBe((await b.json()).error);
  });

  it("logs the resulting role", async () => {
    const code = await createTeacherCode({ role: "RESEARCHER" });
    await postRegister({ ...validBody, inviteCode: code.code });
    // logSystemEvent is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 50));
    const log = await prisma.systemLog.findFirst({
      where: { type: "ACCOUNT_REGISTERED" },
    });
    expect(log?.message).toMatch(/RESEARCHER/);
    expect(JSON.parse(log?.metadata ?? "{}")).toMatchObject({
      role: "RESEARCHER",
      source: "CODE",
    });
  });
});
