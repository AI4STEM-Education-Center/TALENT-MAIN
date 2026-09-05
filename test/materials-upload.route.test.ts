import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Auth is mocked per-test. The storage module keeps its PURE key builders real
// (the routes' exact-key checks are the thing under test here) while the
// network-touching helpers are stubbed. vlm-engine is stubbed because the
// completion route kicks off processing as a side effect.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignPutUpload: vi.fn(async () => "https://s3.example/put"),
    headS3Object: vi.fn(async () => ({ contentLength: 1024 })),
  };
});
vi.mock("@/lib/vlm-engine", () => ({ processMaterial: vi.fn(async () => {}) }));

import { POST as pagesPost } from "@/app/api/classes/[id]/materials/[materialId]/pages/route";
import { POST as completePost } from "@/app/api/classes/[id]/materials/[materialId]/complete/route";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import * as storage from "@/lib/storage";
import { buildPageStorageKey, buildStorageKey } from "@/lib/storage";
import { createClass, createTeacher, resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const mockPresignPut = vi.mocked(storage.presignPutUpload);

function jsonReq(body: unknown) {
  return new Request("http://localhost/api/classes/c/materials/m/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}
const ctx = (id: string, materialId: string) => ({
  params: Promise.resolve({ id, materialId }),
});

/** A PENDING material with its class link, ready for /pages + /complete. */
async function pendingMaterial(teacherId: string, classId: string) {
  const id = `mat-${Math.random().toString(36).slice(2)}`;
  return prisma.learningMaterial.create({
    data: {
      id,
      teacherId,
      classId,
      title: "Bayesian Networks",
      originalName: "lecture.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      storageKey: buildStorageKey(teacherId, classId, id, "lecture.pdf"),
      bucket: "test-bucket",
      uploadStatus: "PENDING",
      processingStatus: "IDLE",
      totalPages: 0,
      classLinks: { create: { classId } },
    },
  });
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  mockPresignPut.mockResolvedValue("https://s3.example/put");
  vi.mocked(storage.headS3Object).mockResolvedValue({ contentLength: 1024 });
  process.env.AWS_S3_BUCKET = "test-bucket";
  process.env.AWS_REGION = "us-east-1";
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/classes/[id]/materials/[materialId]/pages", () => {
  it("keys and signs WebP pages when the client declares that format", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await pendingMaterial(teacher.id, cls.id);
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);

    const res = await pagesPost(
      jsonReq({
        pages: [
          { pageNumber: 1, sizeBytes: 500, contentType: "image/webp" },
          { pageNumber: 2, sizeBytes: 500, contentType: "image/webp" },
        ],
      }),
      ctx(cls.id, material.id),
    );

    expect(res.status).toBe(200);
    const { pages } = await res.json();
    expect(pages[0].storageKey).toBe(
      buildPageStorageKey(teacher.id, cls.id, material.id, 1, "webp"),
    );
    expect(pages[0].mimeType).toBe("image/webp");
    // The signed Content-Type has to match the extension, or the PUT is rejected
    // by S3 for a signature mismatch.
    expect(mockPresignPut).toHaveBeenCalledWith(
      "test-bucket",
      pages[0].storageKey,
      "image/webp",
      500,
    );
  });

  it("keeps the legacy PNG contract for a client that declares no format", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await pendingMaterial(teacher.id, cls.id);
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);

    const res = await pagesPost(
      jsonReq({ pages: [{ pageNumber: 1, sizeBytes: 500 }] }),
      ctx(cls.id, material.id),
    );

    const { pages } = await res.json();
    expect(pages[0].storageKey).toBe(
      buildPageStorageKey(teacher.id, cls.id, material.id, 1, "png"),
    );
    expect(pages[0].mimeType).toBe("image/png");
  });

  it("refuses a format it will not accept at completion", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await pendingMaterial(teacher.id, cls.id);
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);

    const res = await pagesPost(
      jsonReq({
        pages: [{ pageNumber: 1, sizeBytes: 500, contentType: "image/jpeg" }],
      }),
      ctx(cls.id, material.id),
    );

    const { pages } = await res.json();
    expect(pages[0].error).toMatch(/contentType/i);
    expect(pages[0].presignedUrl).toBeUndefined();
  });
});

describe("POST /api/classes/[id]/materials/[materialId]/complete", () => {
  it("finalizes pages posted out of order", async () => {
    // Regression: the uploader PUTs pages in concurrent batches and used to send
    // them in whatever order the requests resolved, so any document long enough
    // to need a second batch could arrive shuffled and be rejected outright.
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await pendingMaterial(teacher.id, cls.id);
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);

    const pages = [4, 2, 5, 1, 3].map((pageNumber) => ({
      pageNumber,
      storageKey: buildPageStorageKey(
        teacher.id,
        cls.id,
        material.id,
        pageNumber,
        "webp",
      ),
    }));

    const res = await completePost(
      jsonReq({ pages }),
      ctx(cls.id, material.id),
    );

    expect(res.status).toBe(200);
    const stored = await prisma.materialPage.findMany({
      where: { materialId: material.id },
      orderBy: { pageNumber: "asc" },
    });
    expect(stored.map((p) => p.pageNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(stored.map((p) => p.storageKey)).toEqual(
      [1, 2, 3, 4, 5].map((n) =>
        buildPageStorageKey(teacher.id, cls.id, material.id, n, "webp"),
      ),
    );
    const updated = await prisma.learningMaterial.findUniqueOrThrow({
      where: { id: material.id },
    });
    expect(updated.uploadStatus).toBe("READY");
    expect(updated.totalPages).toBe(5);
  });

  it("still accepts PNG page keys from before the WebP switch", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await pendingMaterial(teacher.id, cls.id);
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);

    const res = await completePost(
      jsonReq({
        pages: [
          {
            pageNumber: 1,
            storageKey: buildPageStorageKey(
              teacher.id,
              cls.id,
              material.id,
              1,
              "png",
            ),
          },
        ],
      }),
      ctx(cls.id, material.id),
    );

    expect(res.status).toBe(200);
  });

  it("rejects a page whose number is missing from the set", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await pendingMaterial(teacher.id, cls.id);
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);

    // Sorting cannot rescue a gap: 1, 2, 4 has no page 3.
    const res = await completePost(
      jsonReq({
        pages: [1, 2, 4].map((pageNumber) => ({
          pageNumber,
          storageKey: buildPageStorageKey(
            teacher.id,
            cls.id,
            material.id,
            pageNumber,
            "webp",
          ),
        })),
      }),
      ctx(cls.id, material.id),
    );

    expect(res.status).toBe(400);
    expect(
      await prisma.materialPage.count({ where: { materialId: material.id } }),
    ).toBe(0);
  });

  it("rejects a key pointing at another teacher's material", async () => {
    const { user, teacher } = await createTeacher();
    const other = await createTeacher();
    const cls = await createClass(teacher.id);
    const otherClass = await createClass(other.teacher.id);
    const material = await pendingMaterial(teacher.id, cls.id);
    const victim = await pendingMaterial(other.teacher.id, otherClass.id);
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);

    const res = await completePost(
      jsonReq({
        pages: [
          {
            pageNumber: 1,
            storageKey: buildPageStorageKey(
              other.teacher.id,
              otherClass.id,
              victim.id,
              1,
              "webp",
            ),
          },
        ],
      }),
      ctx(cls.id, material.id),
    );

    expect(res.status).toBe(400);
  });
});
