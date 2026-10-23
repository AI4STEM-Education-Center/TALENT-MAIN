import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    copyS3Object: vi.fn().mockResolvedValue(undefined),
    deleteS3Objects: vi.fn().mockResolvedValue(undefined),
  };
});

import { auth } from "@/lib/auth";
import { copyS3Object } from "@/lib/storage";
import { prisma } from "@/lib/prisma";
import { POST as promote } from "@/app/api/admin/materials/[materialId]/promote/route";
import { GET as listMaterials } from "@/app/api/admin/materials/route";
import { createClass, createTeacher, resetDb } from "./db";

const asRole = (role: string) =>
  vi.mocked(auth).mockResolvedValue({ user: { id: "u", role } } as never);
const params = (materialId: string) => ({
  params: Promise.resolve({ materialId }),
});

beforeEach(async () => {
  await resetDb();
  vi.mocked(auth).mockReset();
  vi.mocked(copyS3Object).mockClear();
});
afterAll(() => prisma.$disconnect());

async function seedMaterial(
  overrides: Partial<{
    teacherId: string | null;
    classId: string | null;
    sourceMaterialId: string;
    processingStatus: string;
  }> = {},
) {
  return prisma.learningMaterial.create({
    data: {
      title: "Newton's Laws",
      originalName: "newton.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      storageKey: `learning-materials/${crypto.randomUUID()}/newton.pdf`,
      bucket: "test-bucket",
      uploadStatus: "READY",
      processingStatus: "SUCCESS",
      totalPages: 1,
      processedPages: 1,
      ...overrides,
    },
  });
}

async function seedTeacherMaterial(
  overrides: Parameters<typeof seedMaterial>[0] = {},
) {
  const { teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  const material = await seedMaterial({
    teacherId: teacher.id,
    classId: cls.id,
    ...overrides,
  });
  return { teacher, cls, material };
}

describe("POST /api/admin/materials/[materialId]/promote", () => {
  it("copies a teacher's class material into the global pool", async () => {
    const { material } = await seedTeacherMaterial();
    asRole("ADMIN");

    const response = await promote({} as never, params(material.id));
    expect(response.status).toBe(201);
    const { material: copy } = await response.json();
    expect(copy).toMatchObject({
      teacherId: null,
      classId: null,
      sourceMaterialId: material.id,
      processingStatus: "SUCCESS",
    });
    expect(copy.storageKey).not.toBe(material.storageKey);
    expect(copyS3Object).toHaveBeenCalled();

    // The teacher's original is untouched.
    const original = await prisma.learningMaterial.findUniqueOrThrow({
      where: { id: material.id },
    });
    expect(original.teacherId).toBe(material.teacherId);
    expect(original.classId).toBe(material.classId);
  });

  it("is admin-only", async () => {
    const { material } = await seedTeacherMaterial();
    for (const role of ["RESEARCHER", "TEACHER", "STUDENT"]) {
      asRole(role);
      const response = await promote({} as never, params(material.id));
      expect(response.status).toBe(403);
    }
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await promote({} as never, params(material.id))).status).toBe(401);
    expect(
      await prisma.learningMaterial.count({ where: { teacherId: null } }),
    ).toBe(0);
  });

  it("rejects materials that have not finished processing", async () => {
    const { material } = await seedTeacherMaterial({
      processingStatus: "PROCESSING",
    });
    asRole("ADMIN");
    const response = await promote({} as never, params(material.id));
    expect(response.status).toBe(409);
    expect(
      await prisma.learningMaterial.count({ where: { teacherId: null } }),
    ).toBe(0);
  });

  it("404s for pool materials and unknown ids", async () => {
    const pool = await seedMaterial({ teacherId: null });
    asRole("ADMIN");
    expect((await promote({} as never, params(pool.id))).status).toBe(404);
    expect((await promote({} as never, params("missing"))).status).toBe(404);
  });
});

describe("GET /api/admin/materials pool flag", () => {
  it("marks promoted and pool-imported teacher materials as in the pool", async () => {
    const { teacher, cls, material: promoted } = await seedTeacherMaterial();
    const fresh = await seedMaterial({
      teacherId: teacher.id,
      classId: cls.id,
    });
    const poolItem = await seedMaterial({ teacherId: null });
    const imported = await seedMaterial({
      teacherId: teacher.id,
      classId: cls.id,
      sourceMaterialId: poolItem.id,
    });
    asRole("ADMIN");
    await promote({} as never, params(promoted.id));

    asRole("RESEARCHER");
    const response = await listMaterials({} as never);
    expect(response.status).toBe(200);
    const { materials } = await response.json();
    const inPool = Object.fromEntries(
      materials.map((m: { id: string; inPool: boolean }) => [m.id, m.inPool]),
    );
    expect(inPool).toEqual({
      [promoted.id]: true,
      [fresh.id]: false,
      [imported.id]: true,
    });
  });
});
