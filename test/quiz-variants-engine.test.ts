import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { runQuizVariant } from "@/lib/quiz-variants-engine";
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
  it("retains failed candidates for editing and does not accept an incorrect solution", async () => {
    const version = await fixture();
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [candidate] }))
      .mockResolvedValueOnce(
        answer({ reviews: [{ ...review.reviews[0], answerNumeric: 9 }] }),
      );
    await runQuizVariant(version.id);
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.error).toContain("disagrees");
    expect(JSON.parse(row.questions)).toEqual([candidate]);
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
