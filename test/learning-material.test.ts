import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { listClassMaterials, materialLinkedToClass } from "@/lib/learning-material";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createClass } from "./db";

async function createMaterial(teacherId: string) {
  return prisma.learningMaterial.create({
    data: {
      teacherId,
      originalName: "notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      storageKey: "learning-materials/x/notes.pdf",
      bucket: "bucket",
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("materialLinkedToClass", () => {
  it("returns true when the material is linked to the class", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await createMaterial(teacher.id);
    await prisma.materialClass.create({ data: { materialId: material.id, classId: cls.id } });

    expect(await materialLinkedToClass(material.id, cls.id)).toBe(true);
  });

  it("returns false when there is no link", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await createMaterial(teacher.id);

    expect(await materialLinkedToClass(material.id, cls.id)).toBe(false);
  });

  it("returns false for unknown ids", async () => {
    expect(await materialLinkedToClass("nope", "nope")).toBe(false);
  });

  it("is specific to the (material, class) pair", async () => {
    const { teacher } = await createTeacher();
    const classA = await createClass(teacher.id, "A");
    const classB = await createClass(teacher.id, "B");
    const material = await createMaterial(teacher.id);
    await prisma.materialClass.create({ data: { materialId: material.id, classId: classA.id } });

    expect(await materialLinkedToClass(material.id, classA.id)).toBe(true);
    expect(await materialLinkedToClass(material.id, classB.id)).toBe(false);
  });
});

describe("listClassMaterials", () => {
  it("returns persisted AI metrics used by both the initial page and polling response", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await prisma.learningMaterial.create({
      data: {
        teacherId: teacher.id,
        classId: cls.id,
        originalName: "forces.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        storageKey: "learning-materials/x/forces.pdf",
        bucket: "bucket",
        uploadStatus: "READY",
        processingStatus: "SUCCESS",
        aiModel: "openai/gpt-5.5",
        aiTtftMs: 43_787,
        aiTotalMs: 89_252,
        aiTokens: 2_776,
        classLinks: { create: { classId: cls.id } },
      },
    });

    const items = await listClassMaterials(cls.id);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: material.id,
      aiModel: "openai/gpt-5.5",
      aiTtftMs: 43_787,
      aiTotalMs: 89_252,
      aiTokens: 2_776,
      isImported: false,
    });
    expect(items[0].createdAt).toEqual(expect.any(String));
  });
});
