import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/quiz-variant-requests", () => ({
  requestQuizVariant: (call: () => Promise<unknown>) => call(),
}));
vi.mock("@/lib/ai-provider", () => ({
  resolveProvider: vi.fn(),
  createOpenAIClient: vi.fn(),
  thinkingParams: () => ({}),
}));
vi.mock("@/lib/ai-streaming", () => ({
  streamJsonCompletion: vi.fn(),
  streamOptionsFor: () => ({}),
  transportFor: () => ({}),
}));
import { prisma } from "@/lib/prisma";
import { resolveProvider } from "@/lib/ai-provider";
import { streamJsonCompletion } from "@/lib/ai-streaming";
import {
  MAX_GENERATION_ATTEMPTS,
  runQuizVariant,
} from "@/lib/quiz-variants-engine";
import { resetDb } from "./db";
const source = {
  id: "source",
  sourceQuestionId: "source",
  text: "What is 6/2?",
  answerMode: "NUMERIC",
  answerUnit: null,
  answerNumeric: 3,
  answerTolerance: 0.01,
  options: [],
  solution: "6/2=3",
  intentExplanation: "Divide whole numbers.",
};
const candidate = {
  ...source,
  id: "variant",
  text: "What is 8/2?",
  answerNumeric: 4,
  solution: "8/2=4",
};
const review = {
  reviews: [
    {
      sourceQuestionId: "source",
      answerNumeric: 4,
      correctOptionId: null,
      intentPreserved: true,
      unambiguous: true,
      explanation: "8/2=4",
    },
  ],
};
function answer(value: unknown) {
  return { value, metrics: { completionTokens: 100 } } as never;
}
beforeEach(async () => {
  await resetDb();
  vi.resetAllMocks();
  vi.mocked(resolveProvider).mockResolvedValue({
    providerType: "local",
    model: "test-model",
  } as never);
});
async function fixture() {
  const quiz = await prisma.quiz.create({ data: { name: "Original" } });
  return prisma.quizPracticeVersion.create({
    data: {
      quizId: quiz.id,
      name: "Practice",
      variation: "NUMBERS",
      sourceSnapshot: JSON.stringify([source]),
      objectives: JSON.stringify([
        { sourceQuestionId: "source", objective: "Divide whole numbers." },
      ]),
    },
  });
}
describe("variant generation worker", () => {
  it("generates and blind-solves a draft, records metrics, and never auto-publishes", async () => {
    const version = await fixture();
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [candidate] }))
      .mockResolvedValueOnce(answer(review));
    await runQuizVariant(version.id);
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(row.status).toBe("REVIEW");
    expect(row.aiTokens).toBe(200);
    const message = vi.mocked(streamJsonCompletion).mock.calls[1][1].messages[1]
      .content as string;
    const blind = JSON.parse(message.split("Candidates: ")[1]);
    expect(blind[0]).not.toHaveProperty("answerNumeric");
    expect(blind[0]).not.toHaveProperty("solution");
    expect(blind[0]).not.toHaveProperty("intentExplanation");
  });
  it("regenerates a rejected draft with the reasons until one passes", async () => {
    const version = await fixture();
    const wrong = { reviews: [{ ...review.reviews[0], answerNumeric: 9 }] };
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [candidate] }))
      .mockResolvedValueOnce(answer(wrong))
      .mockResolvedValueOnce(answer({ questions: [candidate] }))
      .mockResolvedValueOnce(answer(review));
    await runQuizVariant(version.id);
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(row.status).toBe("REVIEW");
    expect(row.attempts).toBe(2);
    expect(row.aiTokens).toBe(400);
    const retryPrompt = vi.mocked(streamJsonCompletion).mock.calls[2][1]
      .messages[1].content as string;
    expect(retryPrompt).toContain("failed automatic checks");
    expect(retryPrompt).toContain("disagrees");
  });
  it("fails for teacher attention only after every attempt is rejected, keeping the last draft", async () => {
    const version = await fixture();
    const wrong = { reviews: [{ ...review.reviews[0], answerNumeric: 9 }] };
    for (let i = 0; i < MAX_GENERATION_ATTEMPTS; i++)
      vi.mocked(streamJsonCompletion)
        .mockResolvedValueOnce(answer({ questions: [candidate] }))
        .mockResolvedValueOnce(answer(wrong));
    await runQuizVariant(version.id);
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(streamJsonCompletion).toHaveBeenCalledTimes(
      MAX_GENERATION_ATTEMPTS * 2,
    );
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(MAX_GENERATION_ATTEMPTS);
    expect(row.error).toContain("No draft passed verification");
    expect(row.error).toContain("disagrees");
    expect(JSON.parse(row.questions)).toEqual([candidate]);
  });
  it("re-verifies a teacher-edited draft without replacing it", async () => {
    const version = await fixture();
    await prisma.quizPracticeVersion.update({
      where: { id: version.id },
      data: { questions: JSON.stringify([candidate]), teacherEdited: true },
    });
    vi.mocked(streamJsonCompletion).mockResolvedValueOnce(
      answer({ reviews: [{ ...review.reviews[0], answerNumeric: 9 }] }),
    );
    await runQuizVariant(version.id);
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(streamJsonCompletion).toHaveBeenCalledOnce();
    expect(row.status).toBe("FAILED");
    expect(row.error).not.toContain("No draft passed");
    expect(JSON.parse(row.questions)).toEqual([candidate]);
  });
  it("applies teacher feedback against the draft it revises", async () => {
    const version = await fixture();
    const previous = await prisma.quizPracticeVersion.create({
      data: {
        quizId: version.quizId,
        name: "Practice",
        variation: "NUMBERS",
        status: "DISCARDED",
        sourceSnapshot: version.sourceSnapshot,
        objectives: version.objectives,
        questions: JSON.stringify([{ ...candidate, text: "What is 10/2?" }]),
      },
    });
    await prisma.quizPracticeVersion.update({
      where: { id: version.id },
      data: { feedback: "Use smaller numbers.", revisedFromId: previous.id },
    });
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [candidate] }))
      .mockResolvedValueOnce(answer(review));
    await runQuizVariant(version.id);
    const prompt = vi.mocked(streamJsonCompletion).mock.calls[0][1].messages[1]
      .content as string;
    expect(prompt).toContain("Use smaller numbers.");
    expect(prompt).toContain("What is 10/2?");
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: version.id },
        })
      ).status,
    ).toBe("REVIEW");
  });
  it("revalidates edits without regenerating and ignores duplicate delivery", async () => {
    const version = await fixture();
    await prisma.quizPracticeVersion.update({
      where: { id: version.id },
      data: { questions: JSON.stringify([candidate]) },
    });
    vi.mocked(streamJsonCompletion).mockResolvedValueOnce(answer(review));
    await runQuizVariant(version.id);
    await runQuizVariant(version.id);
    expect(streamJsonCompletion).toHaveBeenCalledOnce();
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: version.id },
        })
      ).status,
    ).toBe("REVIEW");
  });
  it("records provider failures as retryable and never exposes a draft", async () => {
    const version = await fixture();
    vi.mocked(resolveProvider).mockResolvedValue(null);
    await runQuizVariant(version.id);
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: version.id },
        })
      ).status,
    ).toBe("FAILED");
    expect(streamJsonCompletion).not.toHaveBeenCalled();
  });
  it("fences an old worker after a timeout and retry claim", async () => {
    const version = await fixture();
    vi.mocked(streamJsonCompletion).mockImplementationOnce(async () => {
      await prisma.quizPracticeVersion.update({
        where: { id: version.id },
        data: {
          status: "GENERATING",
          updatedAt: new Date(Date.now() + 5000),
          questions: "[]",
        },
      });
      return answer({ questions: [candidate] });
    });
    await runQuizVariant(version.id);
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: version.id },
        })
      ).questions,
    ).toBe("[]");
    expect(streamJsonCompletion).toHaveBeenCalledOnce();
  });
});

it("regenerates repeated alternatives rather than presenting duplicate previews", async () => {
  const version = await fixture();
  await prisma.quizPracticeVersion.create({
    data: {
      quizId: version.quizId,
      name: "Earlier preview",
      variation: "NUMBERS",
      status: "REVIEW",
      sourceSnapshot: version.sourceSnapshot,
      objectives: version.objectives,
      questions: JSON.stringify([candidate]),
    },
  });
  const fresh = { ...candidate, text: "What is 12/3?", answerNumeric: 4 };
  vi.mocked(streamJsonCompletion)
    .mockResolvedValueOnce(answer({ questions: [candidate] }))
    .mockResolvedValueOnce(answer({ questions: [fresh] }))
    .mockResolvedValueOnce(answer(review));
  await runQuizVariant(version.id);
  const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
    where: { id: version.id },
  });
  expect(row.status).toBe("REVIEW");
  expect(JSON.parse(row.questions)[0].text).toBe("What is 12/3?");
  expect(
    vi.mocked(streamJsonCompletion).mock.calls[1][1].messages[1].content,
  ).toContain("repeats an existing question");
});
