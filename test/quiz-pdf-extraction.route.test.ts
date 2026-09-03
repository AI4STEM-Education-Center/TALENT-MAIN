import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";

// Auth is mocked per-test. The storage module keeps its PURE key builders /
// prefix helpers real (so the routes' exact-key checks are exercised) while the
// network-touching helpers are stubbed. The queue is fully stubbed so we can
// assert enqueue is called and force it to throw.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignPutUpload: vi.fn(async () => "https://s3.example/put"),
    signObjectReadUrl: vi.fn(async () => "https://s3.example/get"),
    headS3Object: vi.fn(async () => ({ contentLength: 1 })),
    listS3Objects: vi.fn(async () => [] as string[]),
    deleteS3Objects: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/queue", () => ({ enqueueQuizExtraction: vi.fn() }));

import {
  POST as initPost,
  GET as listGet,
} from "@/app/api/quizzes/[id]/pdf-extractions/route";
import {
  GET as pollGet,
  DELETE as discardDelete,
} from "@/app/api/quizzes/[id]/pdf-extractions/[extractionId]/route";
import { POST as completePost } from "@/app/api/quizzes/[id]/pdf-extractions/[extractionId]/complete/route";
import { POST as retryPost } from "@/app/api/quizzes/[id]/pdf-extractions/[extractionId]/retry/route";
import { POST as figuresPost } from "@/app/api/quizzes/[id]/pdf-extractions/[extractionId]/figures/route";
import { POST as commitPost } from "@/app/api/quizzes/[id]/pdf-extractions/[extractionId]/commit/route";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import * as storage from "@/lib/storage";
import { enqueueQuizExtraction } from "@/lib/queue";
import {
  buildQuizExtractionPageKey,
  buildQuizExtractionFigureKey,
  buildQuizExtractionOptionImageKey,
} from "@/lib/storage";
import { resetDb, createTeacher, createStudent } from "./db";

const mockAuth = vi.mocked(auth);
const mockPresignPut = vi.mocked(storage.presignPutUpload);
const mockHead = vi.mocked(storage.headS3Object);
const mockList = vi.mocked(storage.listS3Objects);
const mockDelete = vi.mocked(storage.deleteS3Objects);
const mockEnqueue = vi.mocked(enqueueQuizExtraction);

// ─── request + ctx helpers ─────────────────────────────────────────────────

function jsonReq(body?: unknown) {
  return new Request("http://localhost/api/quizzes/q/pdf-extractions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;
}
const quizCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const extCtx = (id: string, extractionId: string) => ({
  params: Promise.resolve({ id, extractionId }),
});

// ─── auth helpers ───────────────────────────────────────────────────────────

function asAnon() {
  mockAuth.mockResolvedValue(null as never);
}
function asTeacher(userId: string) {
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "TEACHER" },
  } as never);
}
function asStudent(userId: string) {
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "STUDENT" },
  } as never);
}
function asAdmin(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "ADMIN" } } as never);
}

async function createAdminUser() {
  return prisma.user.create({
    data: {
      email: `admin-${Math.random().toString(36).slice(2)}@example.com`,
      username: `admin-${Math.random().toString(36).slice(2)}`,
      hashedPassword: await bcrypt.hash("Password1!", 10),
      firstName: "Ada",
      lastName: "Admin",
      role: "ADMIN",
    },
  });
}

// ─── fixtures ─────────────────────────────────────────────────────────────

async function createQuiz(teacherId: string | null) {
  return prisma.quiz.create({ data: { name: "Quiz", teacherId } });
}

/** Persist an extraction row in a given status for the routes that operate on one. */
async function seedExtraction(opts: {
  quizId: string;
  teacherId: string | null;
  status: string;
  totalPages?: number;
  extractedQuestions?: string | null;
  hasAnswerKey?: boolean | null;
  warnings?: string;
}) {
  const id = `ext-${Math.random().toString(36).slice(2)}`;
  const storageKey = storage.buildQuizExtractionPdfKey(
    opts.teacherId,
    opts.quizId,
    id,
    "quiz.pdf",
  );
  return prisma.quizPdfExtraction.create({
    data: {
      id,
      quizId: opts.quizId,
      teacherId: opts.teacherId,
      originalName: "quiz.pdf",
      sizeBytes: 1234,
      storageKey,
      bucket: "test-bucket",
      status: opts.status,
      totalPages: opts.totalPages ?? 0,
      extractedQuestions: opts.extractedQuestions ?? null,
      hasAnswerKey: opts.hasAnswerKey ?? null,
      warnings: opts.warnings ?? "[]",
    },
  });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockPresignPut.mockReset().mockResolvedValue("https://s3.example/put");
  vi.mocked(storage.signObjectReadUrl)
    .mockReset()
    .mockResolvedValue("https://s3.example/get");
  mockHead.mockReset().mockResolvedValue({ contentLength: 1 });
  mockList.mockReset().mockResolvedValue([]);
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockEnqueue.mockReset().mockReturnValue(undefined);
  process.env.AWS_S3_BUCKET = "test-bucket";
  process.env.AWS_REGION = "us-east-1";
  delete process.env.LEARNING_MATERIAL_MAX_BYTES;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── init: auth matrix ──────────────────────────────────────────────────────

describe("POST /api/quizzes/[id]/pdf-extractions (init) — auth", () => {
  const initBody = {
    originalName: "quiz.pdf",
    sizeBytes: 100,
    pages: [{ pageNumber: 1, sizeBytes: 50 }],
  };

  it("401 for an anonymous user", async () => {
    asAnon();
    const res = await initPost(jsonReq(initBody), quizCtx("q"));
    expect(res.status).toBe(401);
  });

  it("401 for a student", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    const { teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    const res = await initPost(jsonReq(initBody), quizCtx(quiz.id));
    expect(res.status).toBe(401);
  });

  it("404 for a teacher who does not own the quiz", async () => {
    const owner = await createTeacher();
    const other = await createTeacher();
    const quiz = await createQuiz(owner.teacher.id);
    asTeacher(other.user.id);
    const res = await initPost(jsonReq(initBody), quizCtx(quiz.id));
    expect(res.status).toBe(404);
  });

  it("201 for the owning teacher and creates a PENDING_UPLOAD row", async () => {
    const { user, teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    asTeacher(user.id);
    const res = await initPost(jsonReq(initBody), quizCtx(quiz.id));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.pdf.presignedUrl).toBe("https://s3.example/put");
    expect(body.pages).toHaveLength(1);
    const row = await prisma.quizPdfExtraction.findUnique({
      where: { id: body.id },
    });
    expect(row?.status).toBe("PENDING_UPLOAD");
    expect(row?.teacherId).toBe(teacher.id);
  });

  it("201 for an admin extracting into a pool quiz", async () => {
    const admin = await createAdminUser();
    const quiz = await createQuiz(null);
    asAdmin(admin.id);
    const res = await initPost(jsonReq(initBody), quizCtx(quiz.id));
    expect(res.status).toBe(201);
    const body = await res.json();
    const row = await prisma.quizPdfExtraction.findUnique({
      where: { id: body.id },
    });
    expect(row?.teacherId).toBeNull();
  });
});

// ─── init: validation ────────────────────────────────────────────────────────

describe("POST /api/quizzes/[id]/pdf-extractions (init) — validation", () => {
  async function ownerAndQuiz() {
    const { user, teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    asTeacher(user.id);
    return { teacher, quiz };
  }

  it("400 for a non-PDF originalName", async () => {
    const { quiz } = await ownerAndQuiz();
    const res = await initPost(
      jsonReq({
        originalName: "quiz.docx",
        sizeBytes: 100,
        pages: [{ pageNumber: 1, sizeBytes: 50 }],
      }),
      quizCtx(quiz.id),
    );
    expect(res.status).toBe(400);
  });

  it("400 for more than 20 pages", async () => {
    const { quiz } = await ownerAndQuiz();
    const pages = Array.from({ length: 21 }, (_, i) => ({
      pageNumber: i + 1,
      sizeBytes: 10,
    }));
    const res = await initPost(
      jsonReq({ originalName: "quiz.pdf", sizeBytes: 100, pages }),
      quizCtx(quiz.id),
    );
    expect(res.status).toBe(400);
  });

  it("400 for non-contiguous page numbers", async () => {
    const { quiz } = await ownerAndQuiz();
    const res = await initPost(
      jsonReq({
        originalName: "quiz.pdf",
        sizeBytes: 100,
        pages: [
          { pageNumber: 1, sizeBytes: 10 },
          { pageNumber: 3, sizeBytes: 10 },
        ],
      }),
      quizCtx(quiz.id),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an individually oversized declared page", async () => {
    const { quiz } = await ownerAndQuiz();
    process.env.LEARNING_MATERIAL_MAX_BYTES = "100";
    const res = await initPost(
      jsonReq({
        originalName: "quiz.pdf",
        sizeBytes: 100,
        pages: [{ pageNumber: 1, sizeBytes: 101 }],
      }),
      quizCtx(quiz.id),
    );
    delete process.env.LEARNING_MATERIAL_MAX_BYTES;
    expect(res.status).toBe(400);
  });

  it("deletes the row and returns 500 when presigning throws", async () => {
    const { quiz } = await ownerAndQuiz();
    mockPresignPut.mockRejectedValueOnce(new Error("presign boom"));
    const before = await prisma.quizPdfExtraction.count();
    const res = await initPost(
      jsonReq({
        originalName: "quiz.pdf",
        sizeBytes: 100,
        pages: [{ pageNumber: 1, sizeBytes: 50 }],
      }),
      quizCtx(quiz.id),
    );
    expect(res.status).toBe(500);
    expect(await prisma.quizPdfExtraction.count()).toBe(before);
  });
});

// ─── list ─────────────────────────────────────────────────────────────────

describe("GET /api/quizzes/[id]/pdf-extractions (list)", () => {
  it("returns extractions newest first for the owner", async () => {
    const { user, teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    await seedExtraction({
      quizId: quiz.id,
      teacherId: teacher.id,
      status: "AWAITING_REVIEW",
    });
    asTeacher(user.id);
    const res = await listGet(jsonReq() as never, quizCtx(quiz.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extractions).toHaveLength(1);
  });
});

// ─── complete ────────────────────────────────────────────────────────────────

describe("POST .../complete", () => {
  async function setup(status = "PENDING_UPLOAD") {
    const { user, teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    const ext = await seedExtraction({
      quizId: quiz.id,
      teacherId: teacher.id,
      status,
    });
    asTeacher(user.id);
    const goodPages = [
      {
        pageNumber: 1,
        storageKey: buildQuizExtractionPageKey(teacher.id, quiz.id, ext.id, 1),
      },
      {
        pageNumber: 2,
        storageKey: buildQuizExtractionPageKey(teacher.id, quiz.id, ext.id, 2),
      },
    ];
    return { teacher, quiz, ext, goodPages };
  }

  it("400 when not in PENDING_UPLOAD", async () => {
    const { quiz, ext, goodPages } = await setup("EXTRACTING");
    const res = await completePost(
      jsonReq({ pages: goodPages }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(400);
  });

  it("400 for a storageKey that does not match the deterministic key", async () => {
    const { quiz, ext } = await setup();
    const res = await completePost(
      jsonReq({
        pages: [
          { pageNumber: 1, storageKey: "quiz-extractions/evil/other/key.png" },
        ],
      }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(400);
  });

  it("400 'upload incomplete' when a head check fails", async () => {
    const { quiz, ext, goodPages } = await setup();
    mockHead.mockRejectedValueOnce(new Error("not found"));
    const res = await completePost(
      jsonReq({ pages: goodPages }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("upload incomplete");
  });

  it("202 on success: page rows created, status EXTRACTING, enqueue called", async () => {
    const { quiz, ext, goodPages } = await setup();
    const res = await completePost(
      jsonReq({ pages: goodPages }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("EXTRACTING");
    expect(body.totalPages).toBe(2);
    const rows = await prisma.quizPdfExtractionPage.findMany({
      where: { extractionId: ext.id },
    });
    expect(rows).toHaveLength(2);
    const updated = await prisma.quizPdfExtraction.findUnique({
      where: { id: ext.id },
    });
    expect(updated?.status).toBe("EXTRACTING");
    expect(updated?.totalPages).toBe(2);
    expect(mockEnqueue).toHaveBeenCalledWith(ext.id);
  });

  it("rejects objects whose actual size exceeds the configured maximum", async () => {
    const { quiz, ext, goodPages } = await setup();
    process.env.LEARNING_MATERIAL_MAX_BYTES = "100";
    mockHead.mockResolvedValueOnce({ contentLength: 101 });
    const res = await completePost(
      jsonReq({ pages: goodPages }),
      extCtx(quiz.id, ext.id),
    );
    delete process.env.LEARNING_MATERIAL_MAX_BYTES;
    expect(res.status).toBe(413);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("allows only one concurrent completion to claim an extraction", async () => {
    const { quiz, ext, goodPages } = await setup();
    const [a, b] = await Promise.all([
      completePost(jsonReq({ pages: goodPages }), extCtx(quiz.id, ext.id)),
      completePost(jsonReq({ pages: goodPages }), extCtx(quiz.id, ext.id)),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect(
      await prisma.quizPdfExtractionPage.count({
        where: { extractionId: ext.id },
      }),
    ).toBe(2);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("marks the row FAILED and returns 500 when enqueue throws", async () => {
    const { quiz, ext, goodPages } = await setup();
    mockEnqueue.mockImplementationOnce(() => {
      throw new Error("queue down");
    });
    const res = await completePost(
      jsonReq({ pages: goodPages }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(500);
    const updated = await prisma.quizPdfExtraction.findUnique({
      where: { id: ext.id },
    });
    expect(updated?.status).toBe("FAILED");
    expect(updated?.errorMessage).toBe("queue down");
  });
});

// ─── poll ─────────────────────────────────────────────────────────────────

describe("GET .../[extractionId] (poll)", () => {
  async function setup(opts: {
    status: string;
    extractedQuestions?: string | null;
  }) {
    const { user, teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    const ext = await seedExtraction({
      quizId: quiz.id,
      teacherId: teacher.id,
      status: opts.status,
      extractedQuestions: opts.extractedQuestions,
    });
    asTeacher(user.id);
    return { teacher, quiz, ext };
  }

  it("EXTRACTING returns no questions key", async () => {
    const { quiz, ext } = await setup({ status: "EXTRACTING" });
    const res = await pollGet(jsonReq() as never, extCtx(quiz.id, ext.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("EXTRACTING");
    expect(body).not.toHaveProperty("questions");
    expect(body).not.toHaveProperty("pageImages");
  });

  it("AWAITING_REVIEW returns staged questions and pageImages", async () => {
    const staged = [
      {
        type: "MULTIPLE_CHOICE",
        text: "What is 2+2?",
        points: 1,
        options: [
          { text: "3", isCorrect: false },
          { text: "4", isCorrect: true },
        ],
        numericAnswer: null,
        numericAnswerText: null,
        numericUnit: null,
        hasFigure: false,
        figurePage: null,
        figureBbox: null,
        figureCaption: null,
        figureStorageKey: null,
        sourcePage: 1,
        confidence: 0.9,
        needsReview: false,
        reviewNote: null,
      },
    ];
    const { quiz, ext, teacher } = await setup({
      status: "AWAITING_REVIEW",
      extractedQuestions: JSON.stringify(staged),
    });
    await prisma.quizPdfExtractionPage.create({
      data: {
        extractionId: ext.id,
        pageNumber: 1,
        storageKey: buildQuizExtractionPageKey(teacher.id, quiz.id, ext.id, 1),
      },
    });
    const res = await pollGet(jsonReq() as never, extCtx(quiz.id, ext.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0].text).toBe("What is 2+2?");
    expect(body.pageImages).toEqual([
      { pageNumber: 1, url: "https://s3.example/get" },
    ]);
  });
});

// ─── retry ────────────────────────────────────────────────────────────────

describe("POST .../retry", () => {
  async function setup(status: string) {
    const { user, teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    const ext = await seedExtraction({
      quizId: quiz.id,
      teacherId: teacher.id,
      status,
    });
    asTeacher(user.id);
    return { quiz, ext };
  }

  it("400 when not FAILED", async () => {
    const { quiz, ext } = await setup("AWAITING_REVIEW");
    const res = await retryPost(jsonReq() as never, extCtx(quiz.id, ext.id));
    expect(res.status).toBe(400);
  });

  it("202 from FAILED: status EXTRACTING, errorMessage cleared, enqueue called", async () => {
    const { quiz, ext } = await setup("FAILED");
    await prisma.quizPdfExtraction.update({
      where: { id: ext.id },
      data: { errorMessage: "old" },
    });
    const res = await retryPost(jsonReq() as never, extCtx(quiz.id, ext.id));
    expect(res.status).toBe(202);
    const updated = await prisma.quizPdfExtraction.findUnique({
      where: { id: ext.id },
    });
    expect(updated?.status).toBe("EXTRACTING");
    expect(updated?.errorMessage).toBeNull();
    expect(mockEnqueue).toHaveBeenCalledWith(ext.id);
  });
});

// ─── figures ──────────────────────────────────────────────────────────────

describe("POST .../figures", () => {
  async function setup(status: string) {
    const { user, teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    const ext = await seedExtraction({
      quizId: quiz.id,
      teacherId: teacher.id,
      status,
    });
    asTeacher(user.id);
    return { teacher, quiz, ext };
  }

  it("400 when not AWAITING_REVIEW", async () => {
    const { quiz, ext } = await setup("EXTRACTING");
    const res = await figuresPost(
      jsonReq({ questionFigures: [0] }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(400);
  });

  it("400 when neither questionFigures nor optionImages is given", async () => {
    const { quiz, ext } = await setup("AWAITING_REVIEW");
    const res = await figuresPost(jsonReq({}), extCtx(quiz.id, ext.id));
    expect(res.status).toBe(400);
  });

  it("returns fresh write-once question-figure keys (deduped)", async () => {
    const { teacher, quiz, ext } = await setup("AWAITING_REVIEW");
    const res = await figuresPost(
      jsonReq({ questionFigures: [0, 2, 0] }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questionFigures).toHaveLength(2); // deduped
    for (const figure of body.questionFigures) {
      const base = buildQuizExtractionFigureKey(
        teacher.id,
        quiz.id,
        ext.id,
        figure.questionIndex,
      );
      expect(figure.storageKey.startsWith(base.slice(0, -4))).toBe(true);
      expect(figure.storageKey).toMatch(/-[0-9a-f-]{36}\.png$/);
    }
    expect(body.questionFigures[0].presignedUrl).toBe("https://s3.example/put");
  });

  it("returns fresh write-once keys for per-option image crops", async () => {
    const { teacher, quiz, ext } = await setup("AWAITING_REVIEW");
    const res = await figuresPost(
      jsonReq({
        optionImages: [
          { questionIndex: 1, optionIndex: 0 },
          { questionIndex: 1, optionIndex: 2 },
        ],
      }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.optionImages).toHaveLength(2);
    for (const option of body.optionImages) {
      const base = buildQuizExtractionOptionImageKey(
        teacher.id,
        quiz.id,
        ext.id,
        option.questionIndex,
        option.optionIndex,
      );
      expect(option.storageKey.startsWith(base.slice(0, -4))).toBe(true);
      expect(option.storageKey).toMatch(/-[0-9a-f-]{36}\.png$/);
    }
  });
});

// ─── commit ───────────────────────────────────────────────────────────────

describe("POST .../commit", () => {
  async function setup(status = "AWAITING_REVIEW") {
    const { user, teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    const ext = await seedExtraction({
      quizId: quiz.id,
      teacherId: teacher.id,
      status,
    });
    asTeacher(user.id);
    return { teacher, quiz, ext };
  }

  const numericQuestion = {
    type: "NUMERIC",
    text: "What is the acceleration?",
    points: 2,
    options: [],
    numericAnswer: 9.81,
    numericAnswerText: "9.81",
    numericUnit: "m/s^2",
    hasFigure: false,
    figureStorageKey: null,
    sourcePage: 1,
    confidence: 0.8,
    needsReview: false,
    reviewNote: null,
  };
  const trueFalseQuestion = {
    type: "TRUE_FALSE",
    text: "Gravity pulls down.",
    points: 1,
    options: [
      { text: "True", isCorrect: true },
      { text: "False", isCorrect: false },
    ],
    numericAnswer: null,
    sourcePage: 1,
    confidence: 0.9,
    needsReview: false,
    reviewNote: null,
    hasFigure: false,
    figureStorageKey: null,
  };

  it("409 when not AWAITING_REVIEW (blocks double commit)", async () => {
    const { quiz, ext } = await setup("COMMITTED");
    const res = await commitPost(
      jsonReq({ questions: [numericQuestion] }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(409);
  });

  it("400 for invalid questions", async () => {
    const { quiz, ext } = await setup();
    // NUMERIC missing numericAnswer → validateCommitQuestions throws.
    const bad = { ...numericQuestion, numericAnswer: null };
    const res = await commitPost(
      jsonReq({ questions: [bad] }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(400);
  });

  it("400 for a figure key outside this extraction's prefix", async () => {
    const { quiz, ext } = await setup();
    const foreign = {
      ...trueFalseQuestion,
      hasFigure: true,
      figurePage: 1,
      figureCaption: "diagram",
      figureStorageKey:
        "quiz-extractions/other-teacher/other-quiz/other-ext/figures/figure-0.png",
    };
    const res = await commitPost(
      jsonReq({ questions: [foreign] }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(
      "was not uploaded for this extraction",
    );
  });

  // The case a prefix test cannot catch: a key shaped exactly like one of this
  // extraction's own crops, under its own figures/ folder, that the extraction
  // never handed out a presigned PUT for.
  it("400 for a never-issued key inside this extraction's own figures/ prefix", async () => {
    const { teacher, quiz, ext } = await setup();
    const unissued = `${buildQuizExtractionFigureKey(
      teacher.id,
      quiz.id,
      ext.id,
      0,
    ).replace(/\.png$/, "")}-00000000-0000-4000-8000-000000000000.png`;

    const res = await commitPost(
      jsonReq({
        questions: [
          {
            ...trueFalseQuestion,
            hasFigure: true,
            figurePage: 1,
            figureCaption: "diagram",
            figureStorageKey: unissued,
          },
        ],
      }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(
      "was not uploaded for this extraction",
    );
    expect(await prisma.question.count({ where: { quizId: quiz.id } })).toBe(0);
  });

  it("commits a figure key that /figures actually issued", async () => {
    const { quiz, ext } = await setup("AWAITING_REVIEW");
    const figRes = await figuresPost(
      jsonReq({ questionFigures: [0] }),
      extCtx(quiz.id, ext.id),
    );
    const { questionFigures } = await figRes.json();
    const issuedKey: string = questionFigures[0].storageKey;

    const res = await commitPost(
      jsonReq({
        questions: [
          {
            ...trueFalseQuestion,
            hasFigure: true,
            figurePage: 1,
            figureCaption: "diagram",
            figureStorageKey: issuedKey,
          },
        ],
      }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(200);
    const question = await prisma.question.findFirst({
      where: { quizId: quiz.id },
    });
    expect(question?.figureStorageKey).toBe(issuedKey);
  });

  it("400 for an option-image key outside this extraction's prefix", async () => {
    const { quiz, ext } = await setup();
    const foreign = {
      type: "MULTIPLE_CHOICE",
      text: "Pick the correct graph.",
      points: 1,
      options: [
        {
          text: "",
          isCorrect: true,
          isImage: true,
          imageStorageKey:
            "quiz-extractions/other/other/other/figures/option-0-0.png",
        },
        { text: "b", isCorrect: false },
      ],
      numericAnswer: null,
      sourcePage: 1,
      confidence: 0.9,
      needsReview: false,
      reviewNote: null,
      hasFigure: false,
      figureStorageKey: null,
    };
    const res = await commitPost(
      jsonReq({ questions: [foreign] }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(
      "was not uploaded for this extraction",
    );
  });

  it("commits: QuestionImport + Question/Option rows, NUMERIC + TRUE_FALSE mapping, COMMITTED + import linked", async () => {
    const { teacher, quiz, ext } = await setup();
    const res = await commitPost(
      jsonReq({ questions: [numericQuestion, trueFalseQuestion] }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.importedCount).toBe(2);
    expect(body.skippedCount).toBe(0);
    expect(body.errorCount).toBe(0);
    expect(body.errors).toEqual([]);
    expect(body.importId).toBeTruthy();

    const imp = await prisma.questionImport.findUnique({
      where: { id: body.importId },
    });
    expect(imp?.teacherId).toBe(teacher.id);
    expect(imp?.sourcePath).toBe(`pdf-extraction:${ext.id}`);
    expect(imp?.status).toBe("COMPLETED");

    const questions = await prisma.question.findMany({
      where: { quizId: quiz.id },
      include: { options: true },
    });
    expect(questions).toHaveLength(2);

    const numeric = questions.find((q) => q.answerMode === "NUMERIC")!;
    expect(numeric.answerNumeric).toBe(9.81);
    expect(numeric.answerUnit).toBe("m/s^2");
    expect(numeric.options).toHaveLength(0);

    const tf = questions.find((q) => q.text === "Gravity pulls down.")!;
    expect(tf.answerMode).toBe("SINGLE_SELECT");
    const tfLabels = tf.options.map((o) => o.text).sort();
    expect(tfLabels).toEqual(["False", "True"]);
    const trueOpt = tf.options.find((o) => o.text === "True")!;
    expect(trueOpt.isCorrect).toBe(true);
    const falseOpt = tf.options.find((o) => o.text === "False")!;
    expect(falseOpt.isCorrect).toBe(false);

    const updated = await prisma.quizPdfExtraction.findUnique({
      where: { id: ext.id },
    });
    expect(updated?.status).toBe("COMMITTED");
    expect(updated?.questionImportId).toBe(body.importId);
  });

  it("skips a question whose exact text already exists in the quiz", async () => {
    const { quiz, ext } = await setup();
    await prisma.question.create({
      data: {
        quizId: quiz.id,
        text: trueFalseQuestion.text,
        answerMode: "SINGLE_SELECT",
      },
    });
    const res = await commitPost(
      jsonReq({ questions: [numericQuestion, trueFalseQuestion] }),
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.importedCount).toBe(1);
    expect(body.skippedCount).toBe(1);
  });
});

// ─── discard (DELETE) ────────────────────────────────────────────────────────

describe("DELETE .../[extractionId]", () => {
  async function setup(status: string) {
    const { user, teacher } = await createTeacher();
    const quiz = await createQuiz(teacher.id);
    const ext = await seedExtraction({
      quizId: quiz.id,
      teacherId: teacher.id,
      status,
    });
    asTeacher(user.id);
    return { quiz, ext };
  }

  it("409 when COMMITTED", async () => {
    const { quiz, ext } = await setup("COMMITTED");
    const res = await discardDelete(
      jsonReq() as never,
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(409);
    expect(
      await prisma.quizPdfExtraction.findUnique({ where: { id: ext.id } }),
    ).not.toBeNull();
  });

  it("removes the row and best-effort cleans S3 on success", async () => {
    const { quiz, ext } = await setup("FAILED");
    mockList.mockResolvedValueOnce(["quiz-extractions/x/y/z/quiz.pdf"]);
    const res = await discardDelete(
      jsonReq() as never,
      extCtx(quiz.id, ext.id),
    );
    expect(res.status).toBe(200);
    expect(
      await prisma.quizPdfExtraction.findUnique({ where: { id: ext.id } }),
    ).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });
});
