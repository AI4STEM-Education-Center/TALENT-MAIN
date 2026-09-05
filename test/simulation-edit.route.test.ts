import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueSimulation: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  getS3ObjectAsString: vi
    .fn()
    .mockResolvedValue("<html><body>Wave speed</body></html>"),
}));
vi.mock("@/lib/guardrail-runner", () => ({
  guardText: vi.fn().mockResolvedValue({ blocked: false }),
}));
vi.mock("@/lib/assistant/agent", () => ({ runAssistantTurn: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockReturnValue(null),
}));
import { GET, POST } from "@/app/api/simulations/[id]/edit/route";
import { auth } from "@/lib/auth";
import { runAssistantTurn } from "@/lib/assistant/agent";
import { enqueueSimulation } from "@/lib/queue";
import { guardText } from "@/lib/guardrail-runner";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher } from "./db";
const plan = {
  message: "Ready to replace the label and remove the timer.",
  name: "Explore speed",
  questions: [],
  revisionPrompt:
    "Replace Wave speed with Explore speed. Remove the timer and all associated handlers. Preserve the wave controls, correct units, responsive layout and reset behavior. Verify no timer references remain.",
};
let id: string;
function request(body: unknown) {
  return new Request("http://localhost/api/simulations/x/edit", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as never;
}
const params = () => ({ params: Promise.resolve({ id }) });
async function chat() {
  const res = await POST(
    request({
      action: "chat",
      version: 1,
      message: "Rename Wave speed to Explore speed and remove the timer.",
    }),
    params(),
  );
  expect(res.status).toBe(200);
  return (await res.json()).chatId as string;
}
beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  const { user, teacher } = await createTeacher();
  vi.mocked(auth).mockResolvedValue({
    user: { id: user.id, role: "TEACHER" },
  } as never);
  vi.mocked(guardText).mockResolvedValue({ blocked: false } as never);
  vi.mocked(runAssistantTurn).mockResolvedValue({
    text: JSON.stringify(plan),
    metrics: null,
    toolCallCount: 0,
  });
  const quiz = await prisma.quiz.create({
    data: { name: "Waves", teacherId: teacher.id },
  });
  const q = await prisma.question.create({
    data: { quizId: quiz.id, text: "Private question content" },
  });
  const sim = await prisma.questionSimulation.create({
    data: {
      questionId: q.id,
      status: "READY",
      version: 1,
      title: "Waves",
      topic: "Waves",
      simSpec: "Teach wave speed",
      bucket: "test",
      storageKey: "v1.html",
    },
  });
  id = sim.id;
  await prisma.assistantConfig.create({
    data: { id: "simulation", audience: "simulation", enabled: true },
  });
});
describe("simulation editing", () => {
  it("isolates teachers and denies students", async () => {
    const { user } = await createTeacher();
    vi.mocked(auth).mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);
    expect((await GET(request({}), params())).status).toBe(404);
    vi.mocked(auth).mockResolvedValue({
      user: { id: user.id, role: "STUDENT" },
    } as never);
    expect(
      (await POST(request({ action: "restore", version: 1 }), params())).status,
    ).toBe(404);
  });
  it("persists discussion and queues the detailed plan against an immutable parent exactly once", async () => {
    const chatId = await chat();
    expect(enqueueSimulation).not.toHaveBeenCalled();
    const input = vi.mocked(runAssistantTurn).mock.calls[0][0];
    expect(input.ctx.audience).toBe("simulation");
    expect(JSON.stringify(input)).not.toContain("Private question content");
    const body = { action: "apply", version: 1, chatId };
    expect((await POST(request(body), params())).status).toBe(202);
    const feedback = await prisma.simulationFeedback.findFirstOrThrow();
    expect(feedback).toMatchObject({
      baseVersion: 1,
      versionName: plan.name,
      feedback: plan.revisionPrompt,
    });
    expect((await POST(request(body), params())).status).toBe(409);
    expect(enqueueSimulation).toHaveBeenCalledTimes(1);
  });
  it("does not apply a plan with unresolved questions", async () => {
    vi.mocked(runAssistantTurn).mockResolvedValue({
      text: JSON.stringify({
        ...plan,
        questions: [
          {
            question: "Which direction?",
            options: ["Explore speed", "Compare periods"],
          },
        ],
      }),
      metrics: null,
      toolCallCount: 0,
    });
    const chatId = await chat();
    expect(
      (await POST(request({ action: "apply", version: 1, chatId }), params()))
        .status,
    ).toBe(409);
    expect(enqueueSimulation).not.toHaveBeenCalled();
  });
  it("aborts a proposal without modifying the artifact", async () => {
    const chatId = await chat();
    expect(
      (await POST(request({ action: "abort", version: 1, chatId }), params()))
        .status,
    ).toBe(200);
    expect(
      (await POST(request({ action: "apply", version: 1, chatId }), params()))
        .status,
    ).toBe(409);
    expect(
      (await prisma.questionSimulation.findUniqueOrThrow({ where: { id } }))
        .storageKey,
    ).toBe("v1.html");
  });
  it("restores an earlier version without deleting its descendants and refuses changes during generation", async () => {
    await POST(
      request({ action: "rename", version: 1, name: "Original" }),
      params(),
    );
    await prisma.simulationVersion.create({
      data: {
        simulationId: id,
        number: 2,
        parentNumber: 1,
        name: "New branch",
        bucket: "test",
        storageKey: "v2.html",
      },
    });
    await prisma.questionSimulation.update({
      where: { id },
      data: { version: 2, storageKey: "v2.html" },
    });
    expect(
      (await POST(request({ action: "restore", version: 1 }), params())).status,
    ).toBe(200);
    expect(
      await prisma.simulationVersion.count({ where: { simulationId: id } }),
    ).toBe(2);
    expect(
      (await prisma.questionSimulation.findUniqueOrThrow({ where: { id } }))
        .storageKey,
    ).toBe("v1.html");
    await prisma.questionSimulation.update({
      where: { id },
      data: { status: "REVISING" },
    });
    expect(
      (await POST(request({ action: "restore", version: 2 }), params())).status,
    ).toBe(409);
  });
  it("keeps the plan retryable if enqueue fails", async () => {
    const chatId = await chat();
    vi.mocked(enqueueSimulation).mockImplementationOnce(() => {
      throw new Error("queue unavailable");
    });
    expect(
      (await POST(request({ action: "apply", version: 1, chatId }), params()))
        .status,
    ).toBe(503);
    expect(
      (await prisma.questionSimulation.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe("READY");
    expect(
      (
        await prisma.simulationEditChat.findUniqueOrThrow({
          where: { id: chatId },
        })
      ).state,
    ).toBe("DISCUSSING");
  });
  it("handles invalid model output without queuing or leaving a busy conversation", async () => {
    vi.mocked(runAssistantTurn).mockResolvedValue({
      text: "not JSON",
      metrics: null,
      toolCallCount: 0,
    });
    expect(
      (
        await POST(
          request({ action: "chat", version: 1, message: "Change the title" }),
          params(),
        )
      ).status,
    ).toBe(502);
    expect((await prisma.simulationEditChat.findFirstOrThrow()).state).toBe(
      "DISCUSSING",
    );
    expect(enqueueSimulation).not.toHaveBeenCalled();
  });
  it("lets the assistant navigate only to versions in this simulation", async () => {
    vi.mocked(runAssistantTurn).mockResolvedValue({
      text: JSON.stringify({ ...plan, showVersion: 1 }),
      metrics: null,
      toolCallCount: 0,
    });
    const res = await POST(
      request({ action: "chat", version: 1, message: "Show Original" }),
      params(),
    );
    expect(await res.json()).toMatchObject({
      showVersion: 1,
      plan: { revisionPrompt: "", questions: [] },
    });
    expect(enqueueSimulation).not.toHaveBeenCalled();
  });
  it("does not pass blocked feedback to the model", async () => {
    vi.mocked(guardText).mockResolvedValue({
      blocked: true,
      message: "Blocked",
      eventId: "guard-1",
    } as never);
    const res = await POST(
      request({ action: "chat", version: 1, message: "Blocked input" }),
      params(),
    );
    expect(res.status).toBe(422);
    expect(runAssistantTurn).not.toHaveBeenCalled();
  });
});
