import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/ai-provider", () => ({
  resolveProvider: vi.fn().mockResolvedValue({
    providerType: "local",
    baseUrl: "http://local",
    model: "test",
  }),
  createOpenAIClient: vi.fn().mockResolvedValue({}),
  thinkingParams: () => ({}),
}));
vi.mock("@/lib/storage", () => ({
  getS3ObjectAsString: vi
    .fn()
    .mockResolvedValue("<html>Original branch</html>"),
  getS3Config: () => ({ bucket: "test" }),
  putS3Object: vi.fn(),
  buildSimulationKey: (_t: unknown, _q: unknown, id: string, version: number) =>
    `${id}/v${version}.html`,
}));
vi.mock("@/lib/ai-streaming", () => ({
  streamChatCompletion: vi
    .fn()
    .mockResolvedValue({ text: "<html>Revised</html>", metrics: {} }),
  streamOptionsFor: () => ({}),
  transportFor: () => ({}),
  aggregateMetrics: () => null,
}));
vi.mock("@/lib/simulation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/simulation")>()),
  validateSimulationHtml: () => [],
  extractHtmlDocument: (s: string) => s,
}));
import { runSimulationJob } from "@/lib/simulation-engine";
import { getS3ObjectAsString, putS3Object } from "@/lib/storage";
import { streamChatCompletion } from "@/lib/ai-streaming";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher } from "./db";
import { listSimulationVersions } from "@/lib/simulation-versions";
beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});
async function fixture() {
  const { teacher } = await createTeacher();
  const quiz = await prisma.quiz.create({
    data: { name: "Waves", teacherId: teacher.id },
  });
  const question = await prisma.question.create({
    data: { quizId: quiz.id, text: "Private question" },
  });
  return prisma.questionSimulation.create({
    data: {
      questionId: question.id,
      topic: "Waves",
      title: "Waves",
      simSpec: "Teach waves",
      status: "REVISING",
      version: 1,
      storageKey: "v1.html",
      bucket: "test",
    },
  });
}
it("branches from v1 after restoring it, allocates v4, and preserves v2/v3", async () => {
  const sim = await fixture();
  for (const number of [1, 2, 3])
    await prisma.simulationVersion.create({
      data: {
        simulationId: sim.id,
        number,
        name: `Version ${number}`,
        parentNumber: number > 1 ? number - 1 : null,
        storageKey: `v${number}.html`,
        bucket: "test",
      },
    });
  await prisma.simulationFeedback.create({
    data: {
      simulationId: sim.id,
      authorUserId: "teacher",
      feedback: "Unrelated sibling request",
      status: "APPLIED",
    },
  });
  const feedback = await prisma.simulationFeedback.create({
    data: {
      simulationId: sim.id,
      authorUserId: "teacher",
      feedback: "Add a speed control",
      baseVersion: 1,
      versionName: "Explore speed",
    },
  });
  await runSimulationJob(sim.id, feedback.id);
  expect(getS3ObjectAsString).toHaveBeenCalledWith("test", "v1.html");
  expect(putS3Object).toHaveBeenCalledWith(
    "test",
    `${sim.questionId}/v4.html`,
    expect.any(String),
    expect.any(String),
  );
  expect(
    await prisma.simulationVersion.count({ where: { simulationId: sim.id } }),
  ).toBe(4);
  expect(
    await prisma.simulationVersion.findUniqueOrThrow({
      where: { simulationId_number: { simulationId: sim.id, number: 4 } },
    }),
  ).toMatchObject({ parentNumber: 1, name: "Explore speed" });
  expect(
    (
      await prisma.questionSimulation.findUniqueOrThrow({
        where: { id: sim.id },
      })
    ).version,
  ).toBe(4);
  const prompt = JSON.stringify(vi.mocked(streamChatCompletion).mock.calls[0]);
  expect(prompt).not.toContain("Unrelated sibling request");
  expect(prompt).not.toContain("Private question");
});
it("recovers legacy artifacts without writing during reads", async () => {
  const sim = await fixture();
  const current = await prisma.questionSimulation.update({
    where: { id: sim.id },
    data: { version: 3, storageKey: "v3.html" },
  });
  for (const number of [1, 2])
    await prisma.simulationFeedback.create({
      data: {
        simulationId: sim.id,
        authorUserId: "teacher",
        feedback: "Old edit",
        status: "APPLIED",
        previousStorageKey: `v${number}.html`,
        createdAt: new Date(2026, 0, number),
      },
    });
  expect(
    (await listSimulationVersions(current)).map((v) => [
      v.number,
      v.parentNumber,
      v.storageKey,
    ]),
  ).toEqual([
    [1, null, "v1.html"],
    [2, 1, "v2.html"],
    [3, 2, "v3.html"],
  ]);
  expect(await prisma.simulationVersion.count()).toBe(0);
});
