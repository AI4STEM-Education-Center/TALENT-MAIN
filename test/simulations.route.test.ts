import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueSimulation: vi.fn() }));
vi.mock("@/lib/storage", () => ({ deleteS3Object: vi.fn() }));
vi.mock("@/lib/guardrail-runner", () => ({
  guardText: vi.fn().mockResolvedValue({ blocked: false }),
}));

import { POST as GENERATE } from "@/app/api/simulations/generate/route";
import { POST as ADMIN_GENERATE } from "@/app/api/admin/simulations/generate/route";
import { POST as FEEDBACK } from "@/app/api/simulations/[id]/feedback/route";
import { DELETE as DELETE_SIM } from "@/app/api/simulations/[id]/route";
import { auth } from "@/lib/auth";
import { enqueueSimulation } from "@/lib/queue";
import { deleteS3Object } from "@/lib/storage";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createStudent } from "./db";

const mockAuth = vi.mocked(auth);
const mockEnqueue = vi.mocked(enqueueSimulation);
const mockDeleteS3 = vi.mocked(deleteS3Object);

function jsonReq(body: unknown) {
  return new Request("http://localhost/api/simulations/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function asTeacher(userId: string) {
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "TEACHER" },
  } as never);
}
function asAdmin(userId = "admin-1") {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "ADMIN" } } as never);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** A quiz in `teacherId`'s scope (null = global pool) with `count` questions. */
async function seedQuiz(teacherId: string | null, count = 1) {
  const quiz = await prisma.quiz.create({ data: { name: "Waves", teacherId } });
  const questions = [];
  for (let i = 0; i < count; i += 1) {
    questions.push(
      await prisma.question.create({
        data: { text: `Q${i + 1}`, quizId: quiz.id },
      }),
    );
  }
  return { quiz, questions };
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockEnqueue.mockReset();
  mockDeleteS3.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/simulations/generate", () => {
  it("401s a caller who is neither a teacher nor an admin", async () => {
    const { user } = await createStudent();
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "STUDENT" },
    } as never);
    const res = await GENERATE(jsonReq({ scope: "quiz", quizId: "x" }));
    expect(res.status).toBe(401);
  });

  it("400s an unknown scope (the pool scope stays admin-only)", async () => {
    const { user } = await createTeacher();
    asTeacher(user.id);
    expect((await GENERATE(jsonReq({ scope: "pool" }))).status).toBe(400);
    expect((await GENERATE(jsonReq({ scope: "quiz" }))).status).toBe(400);
  });

  it("queues a simulation for every question of the teacher's own quiz", async () => {
    const { user, teacher } = await createTeacher();
    const { quiz } = await seedQuiz(teacher.id, 2);

    asTeacher(user.id);
    const res = await GENERATE(jsonReq({ scope: "quiz", quizId: quiz.id }));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({
      scope: "quiz",
      totalQuestions: 2,
      created: 2,
      enqueued: 2,
    });
    const sims = await prisma.questionSimulation.findMany();
    expect(sims).toHaveLength(2);
    expect(sims.every((s) => s.status === "PENDING")).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });

  it("re-queues FAILED rows and leaves settled ones alone", async () => {
    const { user, teacher } = await createTeacher();
    const { quiz, questions } = await seedQuiz(teacher.id, 3);
    await prisma.questionSimulation.create({
      data: {
        questionId: questions[0].id,
        status: "READY",
        storageKey: "k",
        version: 1,
      },
    });
    await prisma.questionSimulation.create({
      data: {
        questionId: questions[1].id,
        status: "FAILED",
        errorMessage: "boom",
      },
    });

    asTeacher(user.id);
    const body = await (
      await GENERATE(jsonReq({ scope: "quiz", quizId: quiz.id }))
    ).json();

    expect(body).toMatchObject({
      created: 1,
      retried: 1,
      skipped: 1,
      enqueued: 2,
    });
    const ready = await prisma.questionSimulation.findUniqueOrThrow({
      where: { questionId: questions[0].id },
    });
    expect(ready.status).toBe("READY");
    const retried = await prisma.questionSimulation.findUniqueOrThrow({
      where: { questionId: questions[1].id },
    });
    expect(retried.status).toBe("PENDING");
    expect(retried.errorMessage).toBeNull();
  });

  it("only re-generates a READY simulation when force is set", async () => {
    const { user, teacher } = await createTeacher();
    const { questions } = await seedQuiz(teacher.id, 1);
    await prisma.questionSimulation.create({
      data: {
        questionId: questions[0].id,
        status: "READY",
        storageKey: "k",
        version: 2,
        aiModel: "openai/gpt-5.5",
      },
    });

    asTeacher(user.id);
    const plain = await (
      await GENERATE(
        jsonReq({ scope: "question", questionId: questions[0].id }),
      )
    ).json();
    expect(plain).toMatchObject({ skipped: 1, enqueued: 0 });
    expect(mockEnqueue).not.toHaveBeenCalled();

    const forced = await (
      await GENERATE(
        jsonReq({
          scope: "question",
          questionId: questions[0].id,
          force: true,
        }),
      )
    ).json();
    expect(forced).toMatchObject({ retried: 1, enqueued: 1 });
    const sim = await prisma.questionSimulation.findUniqueOrThrow({
      where: { questionId: questions[0].id },
    });
    expect(sim.status).toBe("PENDING");
    // Stale metrics from the previous job are cleared, the artifact is not:
    // the old version keeps serving until the new one lands.
    expect(sim.aiModel).toBeNull();
    expect(sim.storageKey).toBe("k");
  });

  it("404s a teacher targeting the global pool, and creates nothing", async () => {
    const { user } = await createTeacher();
    const { quiz, questions } = await seedQuiz(null, 1);

    asTeacher(user.id);
    expect(
      (await GENERATE(jsonReq({ scope: "quiz", quizId: quiz.id }))).status,
    ).toBe(404);
    expect(
      (
        await GENERATE(
          jsonReq({ scope: "question", questionId: questions[0].id }),
        )
      ).status,
    ).toBe(404);
    expect(await prisma.questionSimulation.count()).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("404s a teacher targeting another teacher's quiz", async () => {
    const { user } = await createTeacher();
    const other = await createTeacher();
    const { quiz } = await seedQuiz(other.teacher.id, 1);

    asTeacher(user.id);
    expect(
      (await GENERATE(jsonReq({ scope: "quiz", quizId: quiz.id }))).status,
    ).toBe(404);
  });

  it("lets an admin generate on both pool and teacher quizzes", async () => {
    const { teacher } = await createTeacher();
    const pool = await seedQuiz(null, 1);
    const priv = await seedQuiz(teacher.id, 1);

    asAdmin();
    expect(
      (await GENERATE(jsonReq({ scope: "quiz", quizId: pool.quiz.id }))).status,
    ).toBe(202);
    expect(
      (await GENERATE(jsonReq({ scope: "quiz", quizId: priv.quiz.id }))).status,
    ).toBe(202);
    expect(await prisma.questionSimulation.count()).toBe(2);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });

  it("marks a row FAILED when the job cannot be enqueued", async () => {
    const { user, teacher } = await createTeacher();
    const { quiz, questions } = await seedQuiz(teacher.id, 1);
    mockEnqueue.mockImplementation(() => {
      throw new Error("queue unavailable");
    });

    asTeacher(user.id);
    const body = await (
      await GENERATE(jsonReq({ scope: "quiz", quizId: quiz.id }))
    ).json();

    expect(body).toMatchObject({ created: 1, enqueued: 0, enqueueFailed: 1 });
    const sim = await prisma.questionSimulation.findUniqueOrThrow({
      where: { questionId: questions[0].id },
    });
    expect(sim.status).toBe("FAILED");
    expect(sim.errorMessage).toBe("queue unavailable");
  });
});

describe("POST /api/admin/simulations/generate", () => {
  it("generates missing and failed simulations across all quizzes without replacing settled work", async () => {
    const { teacher } = await createTeacher();
    await seedQuiz(null, 1);
    const { questions } = await seedQuiz(teacher.id, 5);
    for (const [i, status] of [
      "FAILED",
      "READY",
      "DECLINED",
      "PENDING",
    ].entries()) {
      await prisma.questionSimulation.create({
        data: { questionId: questions[i].id, status },
      });
    }
    asAdmin();
    const res = await ADMIN_GENERATE(jsonReq({ scope: "all", force: true }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      totalQuestions: 6,
      created: 2,
      retried: 1,
      skipped: 3,
      enqueued: 3,
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(3);
    for (const [i, status] of [
      "PENDING",
      "READY",
      "DECLINED",
      "PENDING",
    ].entries()) {
      expect(
        await prisma.questionSimulation.findUnique({
          where: { questionId: questions[i].id },
        }),
      ).toMatchObject({ status });
    }
  });

  it("keeps the explicit pool scope limited to pool questions", async () => {
    const { teacher } = await createTeacher();
    const pool = await seedQuiz(null, 1);
    await seedQuiz(teacher.id, 1);
    asAdmin();
    expect((await ADMIN_GENERATE(jsonReq({ scope: "pool" }))).status).toBe(202);
    expect(await prisma.questionSimulation.findMany()).toMatchObject([
      { questionId: pool.questions[0].id },
    ]);
  });

  it.each(["quiz", "question"])(
    "lets admins target a teacher-owned %s",
    async (scope) => {
      const { teacher } = await createTeacher();
      const { quiz, questions } = await seedQuiz(teacher.id, 1);
      asAdmin();
      const res = await ADMIN_GENERATE(
        jsonReq({
          scope,
          quizId: quiz.id,
          questionId: questions[0].id,
        }),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ created: 1, enqueued: 1 });
    },
  );

  it.each(["TEACHER", "STUDENT", null])(
    "denies bulk generation to %s",
    async (role) => {
      mockAuth.mockResolvedValue(
        role ? ({ user: { id: "not-admin", role } } as never) : (null as never),
      );
      expect((await ADMIN_GENERATE(jsonReq({ scope: "all" }))).status).toBe(
        403,
      );
      expect(await prisma.questionSimulation.count()).toBe(0);
      expect(mockEnqueue).not.toHaveBeenCalled();
    },
  );
});

describe("admin simulation management", () => {
  it("lets admins revise a teacher-owned simulation", async () => {
    const { teacher } = await createTeacher();
    const { questions } = await seedQuiz(teacher.id);
    const sim = await prisma.questionSimulation.create({
      data: {
        questionId: questions[0].id,
        status: "READY",
        storageKey: "k",
        bucket: "b",
      },
    });
    asAdmin();
    expect(
      (
        await FEEDBACK(
          jsonReq({ feedback: "Correct the units" }),
          params(sim.id),
        )
      ).status,
    ).toBe(202);
    expect(await prisma.simulationFeedback.findFirst()).toMatchObject({
      simulationId: sim.id,
      authorUserId: "admin-1",
      feedback: "Correct the units",
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it("lets admins delete a teacher-owned simulation", async () => {
    const { teacher } = await createTeacher();
    const { questions } = await seedQuiz(teacher.id);
    const sim = await prisma.questionSimulation.create({
      data: {
        questionId: questions[0].id,
        status: "READY",
        storageKey: "k",
        bucket: "b",
      },
    });
    asAdmin();
    expect((await DELETE_SIM({} as never, params(sim.id))).status).toBe(200);
    expect(await prisma.questionSimulation.count()).toBe(0);
    expect(mockDeleteS3).toHaveBeenCalledWith("b", "k");
  });
});

describe("DELETE /api/simulations/[id]", () => {
  it("lets a teacher delete a simulation on their own quiz, with its feedback", async () => {
    const { user, teacher } = await createTeacher();
    const { questions } = await seedQuiz(teacher.id, 1);
    const sim = await prisma.questionSimulation.create({
      data: {
        questionId: questions[0].id,
        status: "READY",
        storageKey: "simulations/t/q/v2.html",
        bucket: "bucket-x",
        version: 2,
      },
    });
    await prisma.simulationFeedback.create({
      data: {
        simulationId: sim.id,
        authorUserId: user.id,
        feedback: "the period formula is wrong",
        previousStorageKey: "simulations/t/q/v1.html",
      },
    });

    asTeacher(user.id);
    const res = await DELETE_SIM({} as never, params(sim.id));

    expect(res.status).toBe(200);
    expect(await prisma.questionSimulation.count()).toBe(0);
    expect(await prisma.simulationFeedback.count()).toBe(0);
    // Both the live artifact and the superseded version it owned are removed.
    expect(mockDeleteS3.mock.calls.map((c) => c[1]).sort()).toEqual([
      "simulations/t/q/v1.html",
      "simulations/t/q/v2.html",
    ]);
  });

  it("keeps the shared artifact when a pool copy still points at it", async () => {
    const { user, teacher } = await createTeacher();
    const pool = await seedQuiz(null, 1);
    const mine = await seedQuiz(teacher.id, 1);
    // The shape deepCopyQuiz produces: two rows, one immutable artifact.
    const sharedKey = "simulations/pool/q/v1.html";
    const poolSim = await prisma.questionSimulation.create({
      data: {
        questionId: pool.questions[0].id,
        status: "READY",
        storageKey: sharedKey,
        bucket: "bucket-x",
        version: 1,
      },
    });
    const copy = await prisma.questionSimulation.create({
      data: {
        questionId: mine.questions[0].id,
        status: "READY",
        storageKey: sharedKey,
        bucket: "bucket-x",
        version: 1,
        sourceSimulationId: poolSim.id,
      },
    });

    asTeacher(user.id);
    expect((await DELETE_SIM({} as never, params(copy.id))).status).toBe(200);

    // The teacher's row is gone; the pool's row and the artifact both survive.
    expect(
      await prisma.questionSimulation.findUnique({ where: { id: copy.id } }),
    ).toBeNull();
    expect(
      await prisma.questionSimulation.findUnique({ where: { id: poolSim.id } }),
    ).not.toBeNull();
    expect(mockDeleteS3).not.toHaveBeenCalled();
  });

  it("404s a teacher deleting a pool simulation", async () => {
    const { user } = await createTeacher();
    const pool = await seedQuiz(null, 1);
    const sim = await prisma.questionSimulation.create({
      data: {
        questionId: pool.questions[0].id,
        status: "READY",
        storageKey: "k",
        bucket: "b",
      },
    });

    asTeacher(user.id);
    expect((await DELETE_SIM({} as never, params(sim.id))).status).toBe(404);
    expect(await prisma.questionSimulation.count()).toBe(1);
    expect(mockDeleteS3).not.toHaveBeenCalled();
  });
});
