import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { presignStoredRecommendations } from "@/lib/exam-results-engine";
import { prisma } from "@/lib/prisma";
import { createTeacher, resetDb } from "./db";

function storedRecommendations(
  simulationId: string,
  withMaterial = false,
): string {
  return JSON.stringify({
    items: withMaterial ? [{ pages: [] }] : [],
    truncated: false,
    simulations: [
      {
        simulationId,
        title: "Wave explorer",
        topic: "Waves",
        learningGoal: "Relate frequency and wavelength",
      },
    ],
  });
}

beforeEach(resetDb);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("simulation recommendation versions", () => {
  it("resolves the newest live version instead of pinning an old result snapshot", async () => {
    const { teacher } = await createTeacher();
    const quiz = await prisma.quiz.create({
      data: { name: "Waves", teacherId: teacher.id },
    });
    const question = await prisma.question.create({
      data: { text: "Q1", quizId: quiz.id },
    });
    const simulation = await prisma.questionSimulation.create({
      data: {
        questionId: question.id,
        status: "READY",
        storageKey: "simulations/teacher/quiz/question/v1.html",
        bucket: "test-bucket",
        version: 1,
      },
    });
    const snapshot = storedRecommendations(simulation.id);

    expect(
      (await presignStoredRecommendations(snapshot)).simulations?.[0],
    ).toMatchObject({
      simulationId: simulation.id,
      version: 1,
    });

    await prisma.questionSimulation.update({
      where: { id: simulation.id },
      data: {
        storageKey: "simulations/teacher/quiz/question/v2.html",
        version: 2,
      },
    });

    expect(
      (await presignStoredRecommendations(snapshot)).simulations?.[0],
    ).toMatchObject({
      simulationId: simulation.id,
      version: 2,
    });
  });

  it("keeps the live version annotation when material recommendations are present", async () => {
    const { teacher } = await createTeacher();
    const quiz = await prisma.quiz.create({
      data: { name: "Waves", teacherId: teacher.id },
    });
    const question = await prisma.question.create({
      data: { text: "Q1", quizId: quiz.id },
    });
    const simulation = await prisma.questionSimulation.create({
      data: {
        questionId: question.id,
        status: "READY",
        storageKey: "simulations/teacher/quiz/question/v3.html",
        bucket: "test-bucket",
        version: 3,
      },
    });

    const result = await presignStoredRecommendations(
      storedRecommendations(simulation.id, true),
    );

    expect(result.simulations?.[0]).toMatchObject({
      simulationId: simulation.id,
      version: 3,
    });
  });
});
