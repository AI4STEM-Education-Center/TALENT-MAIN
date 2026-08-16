import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    copyS3Object: vi.fn().mockResolvedValue(undefined),
    deleteS3Objects: vi.fn().mockResolvedValue(undefined),
  };
});

import { deepCopyLearningMaterial } from "@/lib/material-pool";
import { copyS3Object } from "@/lib/storage";
import { prisma } from "@/lib/prisma";
import { createTeacher, resetDb } from "./db";

beforeEach(async () => {
  await resetDb();
  vi.mocked(copyS3Object).mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("deepCopyLearningMaterial", () => {
  it("creates an independent pool snapshot with its topic, analysis, and S3 objects", async () => {
    const { teacher } = await createTeacher();
    const topic = await prisma.topic.create({ data: { name: "Motion", teacherId: teacher.id } });
    const source = await prisma.learningMaterial.create({
      data: {
        teacherId: teacher.id,
        topicId: topic.id,
        title: "Newton's Laws",
        originalName: "newton.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        storageKey: `learning-materials/${teacher.id}/class/source/newton.pdf`,
        bucket: "test-bucket",
        uploadStatus: "READY",
        processingStatus: "SUCCESS",
        totalPages: 1,
        processedPages: 1,
        batchDescription: "Forces and motion",
        pages: {
          create: {
            pageNumber: 1,
            storageKey: `learning-materials/${teacher.id}/class/source/pages/page-1.png`,
            needed: true,
            keyConcept: "Net force",
            description: "Newton's second law",
          },
        },
      },
    });

    const copy = await deepCopyLearningMaterial(source.id, { teacherId: null, classId: null });
    expect(copy).toMatchObject({
      teacherId: null,
      classId: null,
      sourceMaterialId: source.id,
      title: "Newton's Laws",
      processingStatus: "SUCCESS",
    });
    expect(copy!.storageKey).not.toBe(source.storageKey);
    expect(copy!.topic).toMatchObject({ name: "Motion", teacherId: null });
    const page = await prisma.materialPage.findFirstOrThrow({ where: { materialId: copy!.id } });
    expect(page).toMatchObject({ keyConcept: "Net force", description: "Newton's second law" });
    expect(page.storageKey).not.toContain("/source/");
    expect(copyS3Object).toHaveBeenCalledTimes(2);
  });
});
