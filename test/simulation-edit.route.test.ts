import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueSimulation: vi.fn() }));
/**
 * Shaped like a real artifact so the direct-edit path can be exercised end to
 * end: it has to survive `validateSimulationHtml` after being patched.
 */
const DOC = `<!doctype html>
<html>
<head><style>body { margin: 0; }</style></head>
<body>
<h1>Wave speed</h1>
<div class="card"><span class="sim-latex" data-display="block">v = f\\lambda</span></div>
<div class="card"><span class="sim-latex" data-display="block">T = 1/f</span></div>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1" height="1"/></svg>
<label>Frequency <input id="f" type="range" min="1" max="90" value="30"></label>
<label>Length <input id="len" type="range" min="1" max="20" value="5"></label>
<label>Amplitude <input id="amp" type="range" min="0" max="20" value="1"></label>
<label>Damping <input id="damp" type="range" min="0" max="1" value="0.3"></label>
<script>
const f = document.getElementById("f");
const len = document.getElementById("len");
const amp = document.getElementById("amp");
const damp = document.getElementById("damp");
function draw() { [f, len, amp, damp].map((input) => Number(input.value)); }
f.addEventListener("input", draw);
len.addEventListener("input", draw);
amp.addEventListener("input", draw);
damp.addEventListener("input", draw);
draw();
</script>
</body>
</html>`;
vi.mock("@/lib/storage", () => ({
  getS3ObjectAsString: vi.fn(),
  putS3Object: vi.fn().mockResolvedValue(undefined),
  getS3Config: () => ({ bucket: "test", region: "us-east-1" }),
  buildSimulationKey: (
    _teacher: string | null,
    _quiz: string,
    _question: string,
    version: number,
  ) => `sims/v${version}.html`,
}));
vi.mock("@/lib/ai-provider", () => ({
  resolveProvider: vi.fn().mockResolvedValue({ model: "test-model" }),
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
import { resolveProvider } from "@/lib/ai-provider";
import { getS3ObjectAsString, putS3Object } from "@/lib/storage";
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
  vi.mocked(resolveProvider).mockResolvedValue({
    model: "test-model",
  } as never);
  vi.mocked(getS3ObjectAsString).mockResolvedValue(DOC);
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
  it("lists the previewed version's formulas and the chat's configuration", async () => {
    const res = await GET(
      new Request("http://localhost/api/simulations/x/edit?version=1") as never,
      params(),
    );
    expect(await res.json()).toMatchObject({
      formulaVersion: 1,
      formulas: [
        { index: 0, latex: "v = f\\lambda", display: "block" },
        { index: 1, latex: "T = 1/f", display: "block" },
      ],
      assistant: { enabled: true, model: "test-model" },
    });
  });

  it("names whichever half of the chat setup an admin still has to do", async () => {
    vi.mocked(resolveProvider).mockResolvedValue(null);
    const res = await POST(
      request({ action: "chat", version: 1, message: "Rename the title" }),
      params(),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Assign a model/);
    expect(runAssistantTurn).not.toHaveBeenCalled();

    await prisma.assistantConfig.update({
      where: { id: "simulation" },
      data: { enabled: false },
    });
    const off = await POST(
      request({ action: "chat", version: 1, message: "Rename the title" }),
      params(),
    );
    expect((await off.json()).error).toMatch(/Enable Simulation editing/);
  });

  it("applies text and equation edits directly, branching a new live version", async () => {
    const res = await POST(
      request({
        action: "patch",
        version: 1,
        name: "Fixed period",
        patches: [
          { kind: "text", before: "Wave speed", after: "Wave speed explorer" },
          { kind: "formula-edit", index: 1, latex: "T = 1/f + 1" },
          { kind: "formula-add", latex: "E = hf", display: "block" },
        ],
      }),
      params(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2, showVersion: 2 });
    // No model involved: this is exactly the point of the direct path.
    expect(runAssistantTurn).not.toHaveBeenCalled();
    expect(enqueueSimulation).not.toHaveBeenCalled();

    const written = vi.mocked(putS3Object).mock.calls[0][2] as string;
    expect(written).toContain("<h1>Wave speed explorer</h1>");
    expect(written).toContain("T = 1/f + 1");
    expect(written).toContain("E = hf");
    expect(
      await prisma.simulationVersion.findFirstOrThrow({
        where: { simulationId: id, number: 2 },
      }),
    ).toMatchObject({ name: "Fixed period", parentNumber: 1 });
    expect(
      await prisma.questionSimulation.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ version: 2, storageKey: "sims/v2.html" });
  });

  it("publishes nothing when an edit would break the document or is unsafe", async () => {
    const bad = await POST(
      request({
        action: "patch",
        version: 1,
        patches: [{ kind: "formula-edit", index: 0, latex: "\\frac{1}" }],
      }),
      params(),
    );
    expect(bad.status).toBe(422);
    expect(putS3Object).not.toHaveBeenCalled();

    vi.mocked(guardText).mockResolvedValue({
      blocked: true,
      message: "Blocked",
      eventId: "guard-2",
    } as never);
    const blocked = await POST(
      request({
        action: "patch",
        version: 1,
        patches: [{ kind: "text", before: "Wave speed", after: "Nope" }],
      }),
      params(),
    );
    expect(blocked.status).toBe(422);
    expect(putS3Object).not.toHaveBeenCalled();
    expect(
      await prisma.questionSimulation.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ version: 1 });
  });

  it("refuses a direct edit while a revision is in flight", async () => {
    await prisma.questionSimulation.update({
      where: { id },
      data: { status: "REVISING" },
    });
    const res = await POST(
      request({
        action: "patch",
        version: 1,
        patches: [{ kind: "text", before: "Wave speed", after: "Waves" }],
      }),
      params(),
    );
    expect(res.status).toBe(409);
    expect(
      await prisma.questionSimulation.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ version: 1, storageKey: "v1.html" });
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
