import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
// The password-change notice is best-effort email; stub it so these specs
// exercise the account logic rather than SMTP.
vi.mock("@/lib/password-notices", () => ({
  sendPasswordChangedNotice: vi.fn(async () => true),
}));

import bcrypt from "bcryptjs";
import { GET as GET_PROFILE, PATCH } from "@/app/api/profile/route";
import { POST as CHANGE_PASSWORD } from "@/app/api/profile/password/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendPasswordChangedNotice } from "@/lib/password-notices";
import { resetDb, createStudent, createTeacher } from "./db";

const mockAuth = vi.mocked(auth);
const mockNotice = vi.mocked(sendPasswordChangedNotice);

function asUser(id: string, role = "STUDENT") {
  mockAuth.mockResolvedValue({ user: { id, role } } as never);
}

function patchProfile(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

function postPassword(body: unknown) {
  return CHANGE_PASSWORD(
    new Request("http://localhost/api/profile/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockNotice.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/profile", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await GET_PROFILE()).status).toBe(401);
  });

  it("returns the caller's own details without the password hash", async () => {
    const { user } = await createStudent({
      email: "ada@example.com",
      username: "ada",
    });
    asUser(user.id);

    const res = await GET_PROFILE();
    expect(res.status).toBe(200);
    const { profile } = await res.json();
    expect(profile.email).toBe("ada@example.com");
    expect(profile.username).toBe("ada");
    expect(profile.role).toBe("STUDENT");
    expect(profile).not.toHaveProperty("hashedPassword");
  });

  it("404s when the session points at a deleted account", async () => {
    asUser("ghost");
    expect((await GET_PROFILE()).status).toBe(404);
  });
});

describe("PATCH /api/profile", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect(
      (await patchProfile({ firstName: "A", lastName: "B", email: "a@b.com" }))
        .status,
    ).toBe(401);
  });

  it("updates the name and normalizes the email", async () => {
    const { user } = await createStudent();
    asUser(user.id);

    const res = await patchProfile({
      firstName: "  Ada  ",
      lastName: "Lovelace",
      email: "Ada@Example.COM",
    });
    expect(res.status).toBe(200);

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(stored?.firstName).toBe("Ada");
    expect(stored?.email).toBe("ada@example.com");
  });

  it("rejects a malformed email with 400", async () => {
    const { user } = await createStudent();
    asUser(user.id);
    const res = await patchProfile({
      firstName: "A",
      lastName: "B",
      email: "not-an-email",
    });
    expect(res.status).toBe(400);
  });

  it("rejects blank required fields with 400", async () => {
    const { user } = await createStudent();
    asUser(user.id);
    expect(
      (await patchProfile({ firstName: "  ", lastName: "B", email: "a@b.com" }))
        .status,
    ).toBe(400);
  });

  it("409s when another account already uses the email", async () => {
    const { user } = await createStudent();
    await createTeacher({ email: "taken@example.com" });
    asUser(user.id);

    const res = await patchProfile({
      firstName: "A",
      lastName: "B",
      email: "taken@example.com",
    });
    expect(res.status).toBe(409);
  });

  it("allows saving with the caller's own email unchanged", async () => {
    const { user } = await createStudent({ email: "mine@example.com" });
    asUser(user.id);

    const res = await patchProfile({
      firstName: "New",
      lastName: "Name",
      email: "mine@example.com",
    });
    expect(res.status).toBe(200);
  });

  it("does not let a caller edit someone else's account", async () => {
    const { user: mine } = await createStudent({
      email: "mine@example.com",
      username: "mine",
    });
    const { user: theirs } = await createStudent({
      email: "theirs@example.com",
      username: "theirs",
    });
    asUser(mine.id);

    await patchProfile({
      firstName: "Hijack",
      lastName: "Ed",
      email: "mine@example.com",
    });

    const untouched = await prisma.user.findUnique({
      where: { id: theirs.id },
    });
    expect(untouched?.firstName).toBe("Stu");
  });
});

describe("POST /api/profile/password", () => {
  const CURRENT = "Password1!";
  const NEXT = "Different2@";

  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect(
      (await postPassword({ currentPassword: CURRENT, newPassword: NEXT }))
        .status,
    ).toBe(401);
  });

  it("403s when the current password is wrong", async () => {
    const { user } = await createStudent();
    asUser(user.id);

    const res = await postPassword({
      currentPassword: "WrongPass1!",
      newPassword: NEXT,
    });
    expect(res.status).toBe(403);

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare(CURRENT, stored!.hashedPassword)).toBe(true);
  });

  it("400s a new password that fails the strength rules", async () => {
    const { user } = await createStudent();
    asUser(user.id);
    const res = await postPassword({
      currentPassword: CURRENT,
      newPassword: "weak",
    });
    expect(res.status).toBe(400);
  });

  it("400s when the new password matches the current one", async () => {
    const { user } = await createStudent();
    asUser(user.id);
    const res = await postPassword({
      currentPassword: CURRENT,
      newPassword: CURRENT,
    });
    expect(res.status).toBe(400);
  });

  it("changes the password, emails a notice, and voids outstanding reset links", async () => {
    const { user } = await createStudent();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: "outstanding-hash",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    asUser(user.id);

    const res = await postPassword({
      currentPassword: CURRENT,
      newPassword: NEXT,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, notified: true });

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare(NEXT, stored!.hashedPassword)).toBe(true);
    expect(await bcrypt.compare(CURRENT, stored!.hashedPassword)).toBe(false);

    const token = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: "outstanding-hash" },
    });
    expect(token?.usedAt).not.toBeNull();

    expect(mockNotice).toHaveBeenCalledOnce();
  });

  it("still reports success when the notice email can't be sent", async () => {
    mockNotice.mockResolvedValueOnce(false);
    const { user } = await createStudent();
    asUser(user.id);

    const res = await postPassword({
      currentPassword: CURRENT,
      newPassword: NEXT,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, notified: false });
  });
});
