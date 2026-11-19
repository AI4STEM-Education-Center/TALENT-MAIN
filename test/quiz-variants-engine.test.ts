import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/quiz-variant-requests", () => ({
  requestQuizVariant: (call: () => Promise<unknown>) => call(),
}));
vi.mock("@/lib/ai-provider", () => ({
  resolveProvider: vi.fn(),
  createOpenAIClient: vi.fn(),
  thinkingParams: () => ({}),
}));
vi.mock("@/lib/queue", () => ({
  enqueueVariantEmails: vi.fn(),
  enqueueQuizVariant: vi.fn(),
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
  generateQuizVariantSample,
  runQuizVariant,
  sweepStaleQuizVariants,
} from "@/lib/quiz-variants-engine";
import { recordVariantBatchState } from "@/lib/quiz-variant-notifications";
import { createTeacher, resetDb } from "./db";
const source = {
  id: "source",
  sourceQuestionId: "source",
  text: "What is 6/2?",
  answerMode: "NUMERIC" as const,
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

// ---------------------------------------------------------------------------
// Multi-question, selective revision, sample preview and quality checks.
// ---------------------------------------------------------------------------
const second = {
  ...source,
  id: "source2",
  sourceQuestionId: "source2",
  text: "What is 9/3?",
  answerNumeric: 3,
  solution: "9/3=3",
};
const candidate2 = {
  ...second,
  id: "variant2",
  text: "What is 12/3?",
  answerNumeric: 4,
  solution: "12/3=4",
};
const ok = (q: { sourceQuestionId: string; answerNumeric: number | null }) => ({
  sourceQuestionId: q.sourceQuestionId,
  answerNumeric: q.answerNumeric,
  correctOptionId: null,
  intentPreserved: true,
  unambiguous: true,
  explanation: "Solved independently.",
});
const wrongReview = (q: { sourceQuestionId: string }) => ({
  ...ok({ sourceQuestionId: q.sourceQuestionId, answerNumeric: 99 }),
  explanation: "Got 99",
});
type Call = Parameters<typeof streamJsonCompletion>;
const promptOf = (call: Call) =>
  (call[1] as { messages: { content: string }[] }).messages[1].content;
const nameOf = (call: Call) => (call[2] as { name: string }).name;
const sourcesIn = (prompt: string) =>
  (JSON.parse(prompt.split("Source quiz: ")[1]) as { id: string }[]).map(
    (s) => s.id,
  );
const candidatesIn = (prompt: string) =>
  (
    JSON.parse(prompt.split("Candidates: ")[1]) as {
      sourceQuestionId: string;
    }[]
  ).map((c) => c.sourceQuestionId);

async function twoQuestionFixture(data: Record<string, unknown> = {}) {
  const quiz = await prisma.quiz.create({ data: { name: "Two" } });
  return prisma.quizPracticeVersion.create({
    data: {
      quizId: quiz.id,
      name: "Practice",
      variation: "NUMBERS",
      sourceSnapshot: JSON.stringify([source, second]),
      objectives: JSON.stringify([
        { sourceQuestionId: "source", objective: "Divide whole numbers." },
        { sourceQuestionId: "source2", objective: "Divide whole numbers." },
      ]),
      ...data,
    },
  });
}

describe("partial regeneration", () => {
  it("keeps verified questions and regenerates only the failed one", async () => {
    const version = await twoQuestionFixture();
    const retried = {
      ...candidate2,
      id: "variant2b",
      text: "What is 15/3?",
      answerNumeric: 5,
      solution: "15/3=5",
    };
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [candidate, candidate2] }))
      .mockResolvedValueOnce(
        answer({ reviews: [ok(candidate), wrongReview(candidate2)] }),
      )
      .mockResolvedValueOnce(answer({ questions: [retried] }))
      .mockResolvedValueOnce(answer({ reviews: [ok(retried)] }));
    await runQuizVariant(version.id);
    const calls = vi.mocked(streamJsonCompletion).mock.calls;
    expect(calls).toHaveLength(4);
    expect(sourcesIn(promptOf(calls[2]))).toEqual(["source2"]);
    expect(promptOf(calls[2])).toContain("covering ONLY");
    expect(candidatesIn(promptOf(calls[3]))).toEqual(["source2"]);
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(row.status).toBe("REVIEW");
    expect(JSON.parse(row.questions)).toEqual([candidate, retried]);
    expect(
      JSON.parse(row.validation!).map(
        (r: { sourceQuestionId: string }) => r.sourceQuestionId,
      ),
    ).toEqual(["source", "source2"]);
    expect(row).toMatchObject({
      completedCount: 2,
      totalCount: 2,
      attempts: 2,
      leaseToken: null,
    });
    expect(row.heartbeatAt).not.toBeNull();
  });

  it("revises only the questions the teacher flagged, with their reasons", async () => {
    const quiz = await prisma.quiz.create({ data: { name: "Two" } });
    const previous = await prisma.quizPracticeVersion.create({
      data: {
        quizId: quiz.id,
        name: "Practice",
        variation: "NUMBERS",
        status: "DISCARDED",
        sourceSnapshot: JSON.stringify([source, second]),
        objectives: JSON.stringify([
          { sourceQuestionId: "source", objective: "Divide whole numbers." },
          { sourceQuestionId: "source2", objective: "Divide whole numbers." },
        ]),
        questions: JSON.stringify([candidate, candidate2]),
        validation: JSON.stringify([ok(candidate), ok(candidate2)]),
      },
    });
    const version = await prisma.quizPracticeVersion.create({
      data: {
        quizId: quiz.id,
        name: "Practice",
        variation: "NUMBERS",
        sourceSnapshot: previous.sourceSnapshot,
        objectives: previous.objectives,
        revisedFromId: previous.id,
        questionFeedback: JSON.stringify([
          { sourceQuestionId: "source2", reason: "Numbers are too large." },
        ]),
      },
    });
    const revised = {
      ...candidate2,
      id: "variant2c",
      text: "What is 6/3?",
      answerNumeric: 2,
      solution: "6/3=2",
    };
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [revised] }))
      .mockResolvedValueOnce(answer({ reviews: [ok(revised)] }));
    await runQuizVariant(version.id);
    const calls = vi.mocked(streamJsonCompletion).mock.calls;
    expect(calls).toHaveLength(2);
    const prompt = promptOf(calls[0]);
    expect(sourcesIn(prompt)).toEqual(["source2"]);
    expect(prompt).toContain("Numbers are too large.");
    expect(prompt).toContain("What is 12/3?");
    expect(candidatesIn(promptOf(calls[1]))).toEqual(["source2"]);
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(row.status).toBe("REVIEW");
    expect(JSON.parse(row.questions)).toEqual([candidate, revised]);
    expect(JSON.parse(row.validation!)[0]).toEqual(ok(candidate));
  });

  it("keeps pre-seeded verified samples and generates only the remaining questions", async () => {
    const version = await twoQuestionFixture({
      questions: JSON.stringify([candidate]),
      validation: JSON.stringify([ok(candidate)]),
      completedCount: 1,
    });
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [candidate2] }))
      .mockResolvedValueOnce(answer({ reviews: [ok(candidate2)] }));
    await runQuizVariant(version.id);
    const calls = vi.mocked(streamJsonCompletion).mock.calls;
    expect(sourcesIn(promptOf(calls[0]))).toEqual(["source2"]);
    expect(candidatesIn(promptOf(calls[1]))).toEqual(["source2"]);
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(row.status).toBe("REVIEW");
    expect(JSON.parse(row.questions)).toEqual([candidate, candidate2]);
  });

  it("promotes a fully seeded and verified draft without new provider calls", async () => {
    const version = await fixture();
    await prisma.quizPracticeVersion.update({
      where: { id: version.id },
      data: {
        questions: JSON.stringify([candidate]),
        validation: JSON.stringify([ok(candidate)]),
      },
    });
    await runQuizVariant(version.id);
    expect(streamJsonCompletion).not.toHaveBeenCalled();
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: version.id },
        })
      ).status,
    ).toBe("REVIEW");
  });
});

describe("quality checks and refusals", () => {
  const conceptual = {
    id: "concept",
    sourceQuestionId: "concept",
    text: "A box slides to the right across a rough floor. Which way does friction act on the box?",
    answerMode: "SINGLE_SELECT" as const,
    answerUnit: null,
    answerNumeric: null,
    answerTolerance: null,
    options: [
      {
        id: "c-a",
        text: "Toward the left, opposing the sliding motion",
        isCorrect: true,
      },
      {
        id: "c-b",
        text: "Toward the right, along the motion",
        isCorrect: false,
      },
    ],
    solution: "Kinetic friction opposes relative motion.",
    intentExplanation: "Direction of kinetic friction.",
  };
  async function conceptualFixture(variation: string) {
    const quiz = await prisma.quiz.create({ data: { name: "Concepts" } });
    return prisma.quizPracticeVersion.create({
      data: {
        quizId: quiz.id,
        name: "Practice",
        variation,
        sourceSnapshot: JSON.stringify([conceptual]),
        objectives: JSON.stringify([
          {
            sourceQuestionId: "concept",
            objective: "Identify the direction of friction.",
          },
        ]),
      },
    });
  }
  const choiceReview = (correctOptionId: string) => ({
    reviews: [
      {
        sourceQuestionId: "concept",
        answerNumeric: null,
        correctOptionId,
        intentPreserved: true,
        unambiguous: true,
        explanation: "Friction opposes sliding.",
      },
    ],
  });

  it("rejects a CONTEXT rewrite that clones the original correct choice verbatim", async () => {
    const version = await conceptualFixture("CONTEXT");
    const clone = {
      ...conceptual,
      id: "v1",
      text: "A sled is pushed eastward over packed snow and keeps gliding. In what direction does the snow exert its frictional force on the sled?",
      options: [
        {
          id: "v1-a",
          text: "Toward the left, opposing the sliding motion",
          isCorrect: true,
        },
        {
          id: "v1-b",
          text: "Eastward, in the direction of travel",
          isCorrect: false,
        },
      ],
    };
    const rewritten = {
      ...clone,
      id: "v2",
      options: [
        {
          id: "v2-a",
          text: "Westward, against the sled's glide",
          isCorrect: true,
        },
        {
          id: "v2-b",
          text: "Eastward, in the direction of travel",
          isCorrect: false,
        },
      ],
    };
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [clone] }))
      .mockResolvedValueOnce(answer({ questions: [rewritten] }))
      .mockResolvedValueOnce(answer(choiceReview("v2-a")));
    await runQuizVariant(version.id);
    const calls = vi.mocked(streamJsonCompletion).mock.calls;
    expect(promptOf(calls[0])).toContain("Full question rewrite");
    expect(promptOf(calls[1])).toContain("verbatim");
    expect(nameOf(calls[2])).toBe("quiz_variant_review");
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(row.status).toBe("REVIEW");
    expect(JSON.parse(row.questions)[0].id).toBe("v2");
  });

  it("rejects decorative numbers injected into a conceptual NUMBERS variant", async () => {
    const version = await conceptualFixture("NUMBERS");
    const decorated = {
      ...conceptual,
      id: "d1",
      text: "A 5 kg box slides to the left across a rough floor at 3 m/s. Which way does friction act on the box?",
      options: [
        {
          id: "d1-a",
          text: "Toward the right, opposing the sliding motion",
          isCorrect: true,
        },
        {
          id: "d1-b",
          text: "Toward the left, along the motion",
          isCorrect: false,
        },
      ],
    };
    const conditioned = {
      ...decorated,
      id: "d2",
      text: "A box slides to the left across a rough floor. Which way does friction act on the box?",
      options: [
        {
          id: "d2-a",
          text: "Toward the right, opposing the sliding motion",
          isCorrect: true,
        },
        {
          id: "d2-b",
          text: "Toward the left, along the motion",
          isCorrect: false,
        },
      ],
    };
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [decorated] }))
      .mockResolvedValueOnce(answer({ questions: [conditioned] }))
      .mockResolvedValueOnce(answer(choiceReview("d2-a")));
    await runQuizVariant(version.id);
    const calls = vi.mocked(streamJsonCompletion).mock.calls;
    expect(promptOf(calls[0])).toContain(
      "Limited numerical / condition variation",
    );
    expect(promptOf(calls[1])).toContain("decorative numbers");
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(row.status).toBe("REVIEW");
    expect(JSON.parse(row.questions)[0].id).toBe("d2");
  });

  it("fails at once for teacher attention when the model refuses a flawed source", async () => {
    const version = await fixture();
    vi.mocked(streamJsonCompletion).mockResolvedValueOnce(
      answer({ questions: [], refusalReason: "The answer key is wrong." }),
    );
    await runQuizVariant(version.id);
    expect(streamJsonCompletion).toHaveBeenCalledOnce();
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.error).toContain("The answer key is wrong.");
    expect(row.error).not.toContain("No draft passed");
  });

  it("sends a strict generation schema that permits refusals", async () => {
    const version = await fixture();
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(
        answer({ questions: [candidate], refusalReason: null }),
      )
      .mockResolvedValueOnce(answer(review));
    await runQuizVariant(version.id);
    const schema = vi.mocked(streamJsonCompletion).mock.calls[0][2] as {
      strict: boolean;
      schema: { required: string[]; properties: Record<string, unknown> };
    };
    expect(schema.strict).toBe(true);
    expect(schema.schema.required).toEqual(
      expect.arrayContaining(["questions", "refusalReason"]),
    );
  });

  it("gives the verifier original choices and units but never candidate keys", async () => {
    const version = await fixture();
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [candidate] }))
      .mockResolvedValueOnce(answer(review));
    await runQuizVariant(version.id);
    const prompt = promptOf(vi.mocked(streamJsonCompletion).mock.calls[1]);
    const originals = JSON.parse(
      prompt.split("Originals: ")[1].split("\nCandidates: ")[0],
    );
    expect(originals[0]).toHaveProperty("options");
    expect(originals[0]).toHaveProperty("answerUnit");
    expect(prompt).toContain("textbook conventions");
    expect(prompt.split("Candidates: ")[1]).not.toContain("solution");
  });
});

describe("batch completion", () => {
  it("notifies the requester once the last draft of a round finishes", async () => {
    const teacher = await createTeacher();
    const version = await fixture();
    await prisma.quizPracticeVersion.update({
      where: { id: version.id },
      data: { batchId: "round-1", requestedById: teacher.user.id },
    });
    await prisma.$transaction((tx) =>
      recordVariantBatchState(tx, {
        batchId: "round-1",
        quizId: version.quizId,
        requestedById: teacher.user.id,
        recipientRole: "TEACHER",
        kind: "INITIAL",
      }),
    );
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [candidate] }))
      .mockResolvedValueOnce(answer(review));
    await runQuizVariant(version.id);
    const notes = await prisma.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("QUIZ_VARIANTS_READY");
    expect(
      await prisma.systemLog.count({
        where: { type: "VARIANT_GENERATION_COMPLETED" },
      }),
    ).toBe(1);
  });
});

describe("sample preview", () => {
  it("returns verified NUMBERS and CONTEXT samples and avoids the Flex queue", async () => {
    vi.mocked(resolveProvider).mockResolvedValue({
      providerType: "openai",
      model: "gpt-test",
      serviceTier: "flex",
    } as never);
    const quiz = await prisma.quiz.create({ data: { name: "Sample" } });
    const contextCandidate = {
      ...candidate,
      id: "ctx",
      text: "A baker shares 10 rolls equally between 2 trays. How many rolls go on each tray?",
      answerNumeric: 5,
      solution: "10/2=5",
    };
    vi.mocked(streamJsonCompletion).mockImplementation(async (...args) => {
      const prompt = promptOf(args as Call);
      if (nameOf(args as Call) === "quiz_variant_review") {
        const isContext = prompt.includes("baker");
        return answer({
          reviews: [
            ok({
              sourceQuestionId: "source",
              answerNumeric: isContext ? 5 : 4,
            }),
          ],
        });
      }
      return answer({
        questions: [
          prompt.includes("Variation: CONTEXT") ? contextCandidate : candidate,
        ],
      });
    });
    const result = await generateQuizVariantSample({
      quizId: quiz.id,
      source,
      objective: "Divide whole numbers.",
    });
    expect(result).toMatchObject({
      sourceQuestionId: "source",
      aiModel: "openai/gpt-test",
      numbersSample: {
        question: { id: "variant" },
        check: { answerNumeric: 4 },
      },
      contextSample: { question: { id: "ctx" }, check: { answerNumeric: 5 } },
    });
    const tiers = vi
      .mocked(streamJsonCompletion)
      .mock.calls.map((c) => (c[1] as { service_tier?: string }).service_tier);
    expect(tiers).toHaveLength(4);
    expect(tiers.every((t) => t === "auto")).toBe(true);
  });

  it("keeps the configured Flex tier for background generation", async () => {
    vi.mocked(resolveProvider).mockResolvedValue({
      providerType: "openai",
      model: "gpt-test",
      serviceTier: "flex",
    } as never);
    const version = await fixture();
    vi.mocked(streamJsonCompletion)
      .mockResolvedValueOnce(answer({ questions: [candidate] }))
      .mockResolvedValueOnce(answer(review));
    await runQuizVariant(version.id);
    expect(
      (
        vi.mocked(streamJsonCompletion).mock.calls[0][1] as {
          service_tier?: string;
        }
      ).service_tier,
    ).toBe("flex");
  });

  it("retries a rejected sample up to twice before giving up", async () => {
    const quiz = await prisma.quiz.create({ data: { name: "Sample" } });
    vi.mocked(streamJsonCompletion).mockImplementation(async (...args) => {
      if (nameOf(args as Call) === "quiz_variant_review")
        return answer({ reviews: [wrongReview(source)] });
      return answer({ questions: [candidate] });
    });
    await expect(
      generateQuizVariantSample({
        quizId: quiz.id,
        source,
        objective: "Divide whole numbers.",
      }),
    ).rejects.toThrow(/disagrees/);
    // 3 attempts × (generate + verify) for at least the first mode to fail.
    const generateCalls = vi
      .mocked(streamJsonCompletion)
      .mock.calls.filter((c) => nameOf(c as Call) === "quiz_variant");
    expect(generateCalls.length).toBeGreaterThanOrEqual(3);
    expect(generateCalls.length).toBeLessThanOrEqual(6);
  });
});

describe("stale draft sweep", () => {
  it("never fails queued drafts for their age, only dead GENERATING ones", async () => {
    const teacher = await createTeacher();
    const now = new Date("2026-11-13T12:00:00Z");
    const old = new Date(now.getTime() - 60 * 60_000);
    const fresh = new Date(now.getTime() - 5 * 60_000);
    const queued = await fixture();
    const dead = await fixture();
    const alive = await fixture();
    const legacy = await fixture();
    await prisma.quizPracticeVersion.update({
      where: { id: dead.id },
      data: { status: "GENERATING", heartbeatAt: old, batchId: "round-x" },
    });
    await prisma.quizPracticeVersion.update({
      where: { id: alive.id },
      data: { status: "GENERATING", heartbeatAt: fresh },
    });
    await prisma.$transaction((tx) =>
      recordVariantBatchState(tx, {
        batchId: "round-x",
        quizId: dead.quizId,
        requestedById: teacher.user.id,
        recipientRole: "TEACHER",
        kind: "INITIAL",
      }),
    );
    // An explicit updatedAt overrides Prisma's @updatedAt, backdating rows.
    for (const id of [queued.id, alive.id, dead.id])
      await prisma.quizPracticeVersion.update({
        where: { id },
        data: { updatedAt: old },
      });
    await prisma.quizPracticeVersion.update({
      where: { id: legacy.id },
      data: { status: "GENERATING", heartbeatAt: null, updatedAt: old },
    });
    const enqueue = vi.fn();
    const result = await sweepStaleQuizVariants(enqueue, now);
    expect(result).toEqual({ failed: 2, requeued: 1 });
    const status = async (id: string) =>
      (await prisma.quizPracticeVersion.findUniqueOrThrow({ where: { id } }))
        .status;
    expect(await status(queued.id)).toBe("QUEUED");
    expect(await status(dead.id)).toBe("FAILED");
    expect(await status(legacy.id)).toBe("FAILED");
    expect(await status(alive.id)).toBe("GENERATING");
    expect(enqueue).toHaveBeenCalledWith(queued.id);
    // The failed draft settled its round, so the requester hears about it.
    expect(
      await prisma.notification.count({
        where: { kind: "QUIZ_VARIANTS_READY" },
      }),
    ).toBe(1);
    // A just-re-enqueued draft is not re-enqueued again on the next sweep.
    expect(
      (await sweepStaleQuizVariants(enqueue, new Date(now.getTime() + 60_000)))
        .requeued,
    ).toBe(0);
  });
});
