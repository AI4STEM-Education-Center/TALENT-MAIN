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
    }) as never
  );
}

const validBody = {
  firstName: "New",
  lastName: "Teacher",
  username: "newteacher",
  email: "new@example.com",
  password: "Abcdef1!",
  teacherToken: TOKEN,
};

beforeEach(async () => {
  await resetDb();
  process.env.TEACHER_SIGNUP_TOKEN = TOKEN;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/auth/register", () => {
  it("returns 503 when teacher signup is not configured", async () => {
    delete process.env.TEACHER_SIGNUP_TOKEN;
    const res = await postRegister(validBody);
    expect(res.status).toBe(503);
  });

  it("rejects an invalid teacher token with 403", async () => {
    const res = await postRegister({ ...validBody, teacherToken: "wrong" });
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

  it("normalizes email and username to lowercase", async () => {
    const res = await postRegister({
      ...validBody,
      email: "MixedCase@Example.COM",
      username: "MixedCaseUser",
    });
    expect(res.status).toBe(201);
    const user = await prisma.user.findUnique({ where: { email: "mixedcase@example.com" } });
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
    await createTeacher({ email: "different@example.com", username: "newteacher" });
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

    const res = await postRegister({ ...validBody, teacherToken: code.code });
    expect(res.status).toBe(201);

    const after = await prisma.teacherRegistrationCode.findUnique({ where: { id: code.id } });
    expect(after?.usedCount).toBe(1);
    expect(after?.lastUsedAt).not.toBeNull();
  });

  it("accepts the code in the dash-separated form the admin panel displays", async () => {
    const code = await createTeacherCode({});
    const res = await postRegister({
      ...validBody,
      teacherToken: ` ${formatTeacherCode(code.code).toLowerCase()} `,
    });
    expect(res.status).toBe(201);
  });

  it("returns 503 when no code exists and no env token is set", async () => {
    const res = await postRegister(validBody);
    expect(res.status).toBe(503);
  });

  it("does not report 503 once a usable code exists — a wrong code is a 403", async () => {
    await createTeacherCode({});
    const res = await postRegister({ ...validBody, teacherToken: "WRONGWRONGWRONG1" });
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

    const res = await postRegister({ ...validBody, teacherToken: code.code });
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

    const res = await postRegister({ ...validBody, teacherToken: code.code });
    expect(res.status).toBe(403);
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a code that has hit its use limit", async () => {
    const code = await createTeacherCode({ maxUses: 1 });

    expect((await postRegister({ ...validBody, teacherToken: code.code })).status).toBe(201);

    const second = await postRegister({
      ...validBody,
      teacherToken: code.code,
      email: "second@example.com",
      username: "secondteacher",
    });
    expect(second.status).toBe(403);
    expect(await prisma.user.count()).toBe(1);
  });

  it("does not burn a use when the signup itself fails", async () => {
    const code = await createTeacherCode({ maxUses: 1 });
    await createTeacher({ email: "new@example.com", username: "someoneelse" });

    const res = await postRegister({ ...validBody, teacherToken: code.code });
    expect(res.status).toBe(409);

    const after = await prisma.teacherRegistrationCode.findUnique({ where: { id: code.id } });
    expect(after?.usedCount).toBe(0);
  });

  it("still honours the env token alongside codes, without consuming one", async () => {
    process.env.TEACHER_SIGNUP_TOKEN = TOKEN;
    const code = await createTeacherCode({ maxUses: 1 });

    expect((await postRegister(validBody)).status).toBe(201);

    const after = await prisma.teacherRegistrationCode.findUnique({ where: { id: code.id } });
    expect(after?.usedCount).toBe(0);
  });
});
