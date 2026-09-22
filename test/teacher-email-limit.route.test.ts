import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PATCH } from "@/app/api/admin/teachers/[teacherId]/email-limit/route";
import { createTeacher, resetDb } from "./db";
beforeEach(async () => {
  await resetDb();
  vi.mocked(auth).mockResolvedValue({
    user: { role: "ADMIN", id: "admin" },
  } as never);
});
function patch(teacherId: string, body: unknown) {
  return PATCH(
    new Request("http://localhost/api/admin/teachers/t/email-limit", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ teacherId }) },
  );
}
describe("teacher email limits", () => {
  it.each([
    null,
    [],
    true,
    { emailDailyLimit: true },
    { emailDailyLimit: [] },
    { emailDailyLimit: 0.5 },
    { emailDailyLimit: 2 ** 32 },
  ])("rejects invalid input without changing the cap: %j", async (body) => {
    const { teacher } = await createTeacher();
    expect((await patch(teacher.id, body)).status).toBe(400);
    expect(
      (await prisma.teacher.findUniqueOrThrow({ where: { id: teacher.id } }))
        .emailDailyLimit,
    ).toBeNull();
  });
  it("accepts integer string caps and can reset them to the global default", async () => {
    const { teacher } = await createTeacher();
    expect((await patch(teacher.id, { emailDailyLimit: "10" })).status).toBe(
      200,
    );
    expect(
      (await prisma.teacher.findUniqueOrThrow({ where: { id: teacher.id } }))
        .emailDailyLimit,
    ).toBe(10);
    expect((await patch(teacher.id, { emailDailyLimit: null })).status).toBe(
      200,
    );
    expect(
      (await prisma.teacher.findUniqueOrThrow({ where: { id: teacher.id } }))
        .emailDailyLimit,
    ).toBeNull();
  });
});
