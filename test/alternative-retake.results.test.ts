import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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

import { GET as results } from "@/app/api/student/attempts/[attemptId]/results/route";
import { POST as start, PATCH as submit } from "@/app/api/quiz/practice/route";
import { auth } from "@/lib/auth";
import { enqueueExamResult } from "@/lib/queue";
import { generateExamResult } from "@/lib/exam-results-engine";
import { resolveProvider } from "@/lib/ai-provider";
import { streamChatCompletion, streamJsonCompletion } from "@/lib/ai-streaming";
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

const req = (body: unknown, method = "POST") =>
  new NextRequest("http://localhost/api/quiz/practice", {
    method,
    body: JSON.stringify(body),
  });

async function seed(decision: "AGREE" | "DECLINE") {
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
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.id },
  });
  const quiz = await prisma.quiz.create({
    data: { name: "Forces", teacherId: teacher.id },
  });
  await prisma.classQuiz.create({
    data: { classId: cls.id, quizId: quiz.id, published: true },
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
  await prisma.quizPracticeVersion.create({
    data: {
      quizId: quiz.id,
      name: "Version A",
      status: "PUBLISHED",
      variation: "NUMBERS",
      sourceSnapshot: "[]",
      objectives: "[]",
      questions: JSON.stringify([
        {
          id: "v1",
          sourceQuestionId: question.id,
          text: "What changes an object's velocity?",
          answerMode: "SINGLE_SELECT",
          answerUnit: null,
          answerNumeric: null,
          answerTolerance: null,
          options: [
            { id: "v1-net", text: "A net force", isCorrect: true },
            { id: "v1-motion", text: "Motion itself", isCorrect: false },
          ],
          solution: "Newton's second law",
          intentExplanation: "Same idea",
        },
      ]),
    },
  });
  vi.mocked(auth).mockResolvedValue({
    user: { id: user.id, role: "STUDENT" },
  } as never);
  return { student, cls, quiz, simulation };
}

describe("alternative-version results and recommendations", () => {
  it.each(["AGREE", "DECLINE"] as const)(
    "generates the standard summary, material and simulation recommendations (consent %s)",
    async (decision) => {
      const f = await seed(decision);
      const started = await (
        await start(req({ classId: f.cls.id, quizId: f.quiz.id }))
      ).json();
      const submitted = await (
        await submit(
          req(
            {
              attemptId: started.attemptId,
              answers: [{ questionId: "v1", selectedOptionIds: ["v1-motion"] }],
            },
            "PATCH",
          ),
        )
      ).json();
      expect(submitted.incorrectQuestionIds).toEqual(["v1"]);
      const row = await prisma.examResult.findUniqueOrThrow({
        where: { quizAttemptId: submitted.quizAttemptId },
      });
      expect(enqueueExamResult).toHaveBeenCalledWith(row.id);

      await generateExamResult(row.id);

      // Same endpoint the ordinary results view polls, keyed by the retake.
      const payload = await (
        await results(new Request("http://localhost/r"), {
          params: Promise.resolve({ attemptId: submitted.quizAttemptId }),
        })
      ).json();
      expect(payload.summaryStatus).toBe("READY");
      expect(payload.summary).toBe("Review balanced forces.");
      expect(payload.recommendationsStatus).toBe("READY");
      expect(payload.recommendations).toHaveLength(1);
      // The missed alternative question maps back to the source question's
      // simulation.
      expect(payload.simulations[0].simulationId).toBe(f.simulation.id);
      // Teacher-only diagnostics stay consent-gated and never reach students.
      expect(payload.errorMisconceptions).toBeUndefined();
      const stored = JSON.parse(
        (await prisma.examResult.findUniqueOrThrow({ where: { id: row.id } }))
          .recommendations!,
      );
      expect(stored.errorMisconceptions === undefined).toBe(
        decision === "DECLINE",
      );
    },
  );
});
