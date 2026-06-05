import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { POST } from "@/app/api/auth/register/route";
import { prisma } from "@/lib/prisma";
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
