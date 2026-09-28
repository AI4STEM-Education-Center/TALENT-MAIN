import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueExamResult: vi.fn() }));
vi.mock("@/lib/ai-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-provider")>()),
  resolveProvider: vi.fn(),
  createOpenAIClient: vi.fn(async () => ({})),
}));
vi.mock("@/lib/ai-streaming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-streaming")>()),
  streamChatCompletion: vi.fn(),
  streamJsonCompletion: vi.fn(),
}));
vi.mock("@/lib/misconception-labeling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/misconception-labeling")>()),
  getActiveMisconceptions: vi.fn(async () => [
    { misconceptionId: "force", statement: "Motion requires a net force" },
  ]),
}));

import { GET } from "@/app/api/student/attempts/[attemptId]/results/route";
import { auth } from "@/lib/auth";
import { enqueueExamResult } from "@/lib/queue";
import { generateExamResult } from "@/lib/exam-results-engine";
import { isResultPending, RESULT_STATUS } from "@/lib/exam-results";
import { resolveProvider } from "@/lib/ai-provider";
import { streamChatCompletion, streamJsonCompletion } from "@/lib/ai-streaming";
import { getActiveMisconceptions } from "@/lib/misconception-labeling";
import { prisma } from "@/lib/prisma";
import { createStudent, createTeacher, resetDb } from "./db";

const metrics = {
  model: "test-model",
  ttftMs: 1,
  completionTokens: 12,
  tokensEstimated: false,
  totalMs: 100,
  generationMs: 99,
  tokensPerSec: 121,
};

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  vi.mocked(resolveProvider).mockResolvedValue({
    providerType: "local",
    baseUrl: "http://localhost:1234/v1",
    apiKey: null,
    model: "test-model",
    serviceTier: null,
    thinkingLevel: null,
    apiSurface: "chat_completions",
    timeoutMs: 1000,
  } as never);
  vi.mocked(streamChatCompletion).mockResolvedValue({
    text: "Review balanced forces.",
    toolCalls: [],
    finishReason: "stop",
    metrics,
  });
  vi.mocked(streamJsonCompletion).mockImplementation(
    async (_client, _params, schema) => {
      const { name } = schema as { name: string };
      const values: Record<string, unknown> = {
        material_selection: {
          materials: [{ material_index: 1, reasoning: "Review forces" }],
        },
        page_selection: {
          has_relevant_pages: true,
          start_page: 1,
          end_page: 1,
          reasoning: "Explore balanced forces",
        },
        misconception_labeling: { misconception_ids: ["force"] },
      };
      if (!(name in values)) throw new Error(`Unexpected schema: ${name}`);
      return { value: values[name], metrics } as never;
    },
  );
});

afterAll(() => prisma.$disconnect());

async function seedAttempt(
  decision: "AGREE" | "DECLINE" | null,
  legacy = false,
) {
  const form = await prisma.consentFormVersion.create({
    data: {
      role: "STUDENT",
      version: "v1",
      title: "Student form",
      bodyHtml: "<p>Consent</p>",
      isActive: true,
    },
  });
  const { user, student } = await createStudent();
  if (decision)
    await prisma.consentRecord.create({
      data: {
        userId: user.id,
        role: "STUDENT",
        formVersionId: form.id,
        decision,
        signatureTypedName: "Stu Student",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        deviceType: "desktop",
        signerNameSnapshot: "Stu Student",
        signerEmailSnapshot: user.email,
      },
    });
  const { teacher } = await createTeacher();
  const cls = await prisma.class.create({
    data: { name: "Physics", teacherId: teacher.id },
  });
  const quiz = await prisma.quiz.create({
    data: { name: "Forces", teacherId: teacher.id },
  });
  const question = await prisma.question.create({
    data: { text: "What changes velocity?", quizId: quiz.id },
  });
  const simulation = await prisma.questionSimulation.create({
    data: {
      questionId: question.id,
      status: "READY",
      storageKey: "simulation.html",
      bucket: "test-bucket",
      title: "Force explorer",
    },
  });
  await prisma.learningMaterial.create({
    data: {
      teacherId: teacher.id,
      originalName: "forces.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      storageKey: "forces.pdf",
      bucket: "test-bucket",
      uploadStatus: "READY",
      processingStatus: "SUCCESS",
      batchDescription: "Balanced and unbalanced forces",
      classLinks: { create: { classId: cls.id } },
      pages: {
        create: {
          pageNumber: 1,
          storageKey: "page.webp",
          needed: true,
          description: "Forces",
        },
      },
    },
  });
  const result = await prisma.examResult.create({
    data: {
      quizAttemptId: `attempt-${student.id}`,
      studentId: student.id,
      classId: cls.id,
      quizId: quiz.id,
      className: cls.name,
      topicName: "Forces",
      quizName: quiz.name,
      score: 0,
      correctCount: 0,
      totalCount: 1,
      completedAt: new Date(),
      ...(legacy
        ? {
            summaryStatus: "SKIPPED_NO_CONSENT",
            recommendationsStatus: "SKIPPED_NO_CONSENT",
          }
        : {}),
      reviewSnapshot: JSON.stringify({
        questions: [
          {
            questionId: question.id,
            text: question.text,
            isCorrect: false,
            options: [
              { text: "Net force", isCorrect: true, selected: false },
              { text: "Motion", isCorrect: false, selected: true },
            ],
          },
        ],
      }),
    },
  });
  vi.mocked(auth).mockResolvedValue({
    user: { id: user.id, role: "STUDENT" },
  } as never);
  return { user, result, simulation };
}

describe("AI learning access and research consent", () => {
  it.each(["AGREE", "DECLINE", null] as const)(
    "generates learning support with consent decision %s",
    async (decision) => {
      const { user, result, simulation } = await seedAttempt(decision);
      await generateExamResult(result.id);
      const after = await prisma.examResult.findUniqueOrThrow({
        where: { id: result.id },
      });
      expect(after.summaryStatus).toBe("READY");
      expect(after.summary).toBe("Review balanced forces.");
      expect(after.recommendationsStatus).toBe("READY");
      const stored = JSON.parse(after.recommendations!);
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0].pages).toHaveLength(1);
      expect(stored.simulations[0].simulationId).toBe(simulation.id);
      if (decision === "AGREE") {
        expect(stored.errorMisconceptions).toHaveLength(1);
        expect(getActiveMisconceptions).toHaveBeenCalledOnce();
      } else {
        expect(stored.errorMisconceptions).toBeUndefined();
        expect(getActiveMisconceptions).not.toHaveBeenCalled();
        expect(
          vi
            .mocked(streamJsonCompletion)
            .mock.calls.map((call) => (call[2] as { name: string }).name),
        ).toEqual(["material_selection", "page_selection"]);
      }
      expect(
        await prisma.consentRecord.count({ where: { userId: user.id } }),
      ).toBe(decision ? 1 : 0);
      expect(after.score).toBe(result.score);
    },
  );

  it("requeues a legacy skipped result on read and finishes it without changing consent", async () => {
    const { result } = await seedAttempt("DECLINE", true);
    const response = await GET(
      new Request("http://localhost/api/student/attempts/a/results"),
      {
        params: Promise.resolve({ attemptId: result.quizAttemptId }),
      },
    );
    expect(response.status).toBe(200);
    expect(enqueueExamResult).toHaveBeenCalledWith(result.id);
    expect(isResultPending((await response.json()).summaryStatus)).toBe(true);
    await generateExamResult(result.id);
    const controller = new AbortController();
    const streamed = await GET(
      new Request("http://localhost/api/student/attempts/a/results?stream=1", {
        signal: controller.signal,
      }),
      {
        params: Promise.resolve({ attemptId: result.quizAttemptId }),
      },
    );
    try {
      const body = JSON.parse((await streamed.text()).trim());
      expect(body.summaryStatus).toBe(RESULT_STATUS.READY);
      expect(body.recommendationsStatus).toBe(RESULT_STATUS.READY);
      expect(body.recommendations).toHaveLength(1);
      expect(body.errorMisconceptions).toBeUndefined();
    } finally {
      controller.abort();
    }
    expect((await prisma.consentRecord.findFirst())?.decision).toBe("DECLINE");
    vi.mocked(streamChatCompletion).mockClear();
    vi.mocked(streamJsonCompletion).mockClear();
    await generateExamResult(result.id);
    expect(streamChatCompletion).not.toHaveBeenCalled();
    expect(streamJsonCompletion).not.toHaveBeenCalled();
  });
});
