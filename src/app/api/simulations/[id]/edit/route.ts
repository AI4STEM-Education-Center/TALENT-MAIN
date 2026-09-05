import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  listSimulationVersions,
  snapshotSimulationVersions,
} from "@/lib/simulation-versions";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { getAssistantSettings } from "@/lib/assistant/config";
import { runAssistantTurn } from "@/lib/assistant/agent";
import type { AssistantTurn } from "@/lib/assistant/types";
import { simulationEditPlanSchema } from "@/lib/simulation-edit";
import {
  applySimulationPatches,
  listSimulationFormulas,
  type SimulationPatch,
} from "@/lib/simulation-patch";
import { validateSimulationHtml } from "@/lib/simulation";
import { resolveProvider } from "@/lib/ai-provider";
import {
  buildSimulationKey,
  getS3Config,
  getS3ObjectAsString,
  putS3Object,
} from "@/lib/storage";
import { fenceUntrusted } from "@/lib/guardrail-fence";
import { guardText } from "@/lib/guardrail-runner";
import { rateLimit } from "@/lib/rate-limit";
import { enqueueSimulation } from "@/lib/queue";

export const runtime = "nodejs";
const latexSchema = z.string().trim().min(1).max(500);
const patchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    before: z.string().min(1).max(2000),
    after: z.string().trim().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("formula-edit"),
    index: z.number().int().nonnegative().max(64),
    latex: latexSchema,
  }),
  z.object({
    kind: z.literal("formula-delete"),
    index: z.number().int().nonnegative().max(64),
  }),
  z.object({
    kind: z.literal("formula-add"),
    latex: latexSchema,
    display: z.enum(["inline", "block"]),
  }),
]);
const inputSchema = z.object({
  action: z.enum(["chat", "apply", "restore", "abort", "rename", "patch"]),
  version: z.number().int().positive(),
  chatId: z.string().optional(),
  message: z.string().trim().min(1).max(4000).optional(),
  // Blank is "not supplied": the editor posts its rename box on every action.
  name: z.string().trim().max(80).optional(),
  patches: z.array(patchSchema).min(1).max(20).optional(),
});

/** The teacher-authored words in a patch set — what the guardrails must see. */
function patchText(patches: SimulationPatch[]): string {
  return patches
    .flatMap((patch) => {
      if (patch.kind === "text") return [patch.after];
      return patch.kind === "formula-delete" ? [] : [patch.latex];
    })
    .join("\n");
}
async function access(id: string) {
  const actor = await getContentActor();
  if (!actor) return null;
  const sim = await prisma.questionSimulation.findUnique({
    where: { id },
    include: {
      question: {
        select: {
          id: true,
          quizId: true,
          quiz: { select: { teacherId: true } },
        },
      },
    },
  });
  return sim && canManage(actor, sim.question.quiz) ? { actor, sim } : null;
}
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const found = await access(id);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [versions, chats, settings, provider] = await Promise.all([
    listSimulationVersions(found.sim),
    prisma.simulationEditChat.findMany({
      where: { simulationId: id, userId: found.actor.userId },
      orderBy: { updatedAt: "desc" },
      take: 30,
    }),
    getAssistantSettings("simulation"),
    resolveProvider("simulation_chat"),
  ]);

  // The formulas of whichever version the editor is previewing, so it can offer
  // real add / edit / remove controls instead of asking a teacher to describe an
  // equation in prose. Best-effort: a missing artifact must not break the page.
  const requested = Number(new URL(req.url).searchParams.get("version"));
  const selected =
    versions.find((v) => v.number === requested) ??
    versions.find((v) => v.number === found.sim.version);
  let formulas: ReturnType<typeof listSimulationFormulas> = [];
  if (selected?.storageKey && selected.bucket) {
    try {
      formulas = listSimulationFormulas(
        await getS3ObjectAsString(selected.bucket, selected.storageKey),
      );
    } catch (error) {
      console.error(`[Simulation] Could not read formulas for ${id}:`, error);
    }
  }

  return NextResponse.json({
    versions: versions.map(({ number, name, parentNumber, createdAt }) => ({
      number,
      name,
      parentNumber,
      createdAt,
    })),
    chats,
    activeVersion: found.sim.version,
    formulaVersion: selected?.number ?? null,
    formulas,
    // Both halves have to be configured before the chat can answer, and they
    // live on different admin screens — so the editor names each one it is
    // missing rather than failing with a generic error on the first message.
    assistant: { enabled: settings.enabled, model: provider?.model ?? null },
  });
}
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const found = await access(id);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { actor, sim } = found;
  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid edit request" },
      { status: 400 },
    );
  const body = parsed.data;
  const settings = await getAssistantSettings("simulation");
  const limited = rateLimit(
    req,
    "simulation-edit",
    settings.turnsPerHour,
    3600_000,
    actor.userId,
  );
  if (limited) return limited;
  await snapshotSimulationVersions(sim);
  const base = await prisma.simulationVersion.findUnique({
    where: { simulationId_number: { simulationId: id, number: body.version } },
  });
  if (!base)
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  if (body.action === "restore") {
    const result = await prisma.questionSimulation.updateMany({
      where: { id, status: "READY" },
      data: {
        version: base.number,
        storageKey: base.storageKey,
        bucket: base.bucket,
      },
    });
    return NextResponse.json(
      result.count
        ? { restored: true }
        : { error: "Wait for the current revision to finish" },
      { status: result.count ? 200 : 409 },
    );
  }
  if (body.action === "rename") {
    if (!body.name)
      return NextResponse.json({ error: "Name required" }, { status: 400 });
    await prisma.simulationVersion.update({
      where: { id: base.id },
      data: { name: body.name },
    });
    return NextResponse.json({ renamed: true });
  }
  if (body.action === "patch") {
    if (!body.patches)
      return NextResponse.json(
        { error: "No changes to apply" },
        { status: 400 },
      );
    if (sim.status !== "READY")
      return NextResponse.json(
        { error: "Wait for the current revision to finish" },
        { status: 409 },
      );
    const guard = await guardText(
      patchText(body.patches),
      { surface: "simulation_feedback", id, userId: actor.userId },
      { requestPath: true },
    );
    if (guard.blocked)
      return NextResponse.json(
        { error: guard.message, guardrailEventId: guard.eventId },
        { status: 422 },
      );

    let source: string;
    let bucket: string;
    try {
      [source, bucket] = [
        await getS3ObjectAsString(base.bucket, base.storageKey),
        getS3Config().bucket,
      ];
    } catch (error) {
      console.error(
        `[Simulation] Direct edit of ${id} could not read S3:`,
        error,
      );
      return NextResponse.json(
        { error: "Could not read this version's artifact." },
        { status: 502 },
      );
    }

    const patched = applySimulationPatches(source, body.patches);
    if (!patched.ok)
      return NextResponse.json({ error: patched.problem }, { status: 422 });
    // The same static validation the generator's output must pass. A direct
    // edit skips the revision model, so this is the only thing standing between
    // a teacher's typo and a broken document reaching students.
    const problems = validateSimulationHtml(patched.html);
    if (problems.length)
      return NextResponse.json(
        { error: `These edits would break the simulation: ${problems[0]}` },
        { status: 422 },
      );

    const latest = await prisma.simulationVersion.aggregate({
      where: { simulationId: id },
      _max: { number: true },
    });
    const number = Math.max(sim.version, latest._max.number ?? 0) + 1;
    const key = buildSimulationKey(
      sim.question.quiz.teacherId,
      sim.question.quizId,
      sim.question.id,
      number,
    );
    await putS3Object(bucket, key, patched.html, "text/html; charset=utf-8");
    try {
      await prisma.$transaction(async (tx) => {
        await tx.simulationVersion.create({
          data: {
            simulationId: id,
            number,
            name: body.name || `Direct edit ${number}`,
            parentNumber: base.number,
            storageKey: key,
            bucket,
          },
        });
        const claimed = await tx.questionSimulation.updateMany({
          where: { id, status: "READY" },
          data: { version: number, storageKey: key, bucket },
        });
        if (!claimed.count) throw new Error("Simulation is not READY");
      });
    } catch {
      // Lost the race for this version number, or a revision started between
      // the check above and here. Either way nothing was published.
      return NextResponse.json(
        {
          error:
            "Another change to this simulation landed first. Reload the editor and try again.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ version: number, showVersion: number });
  }
  let chat = body.chatId
    ? await prisma.simulationEditChat.findFirst({
        where: {
          id: body.chatId,
          simulationId: id,
          userId: actor.userId,
          baseVersion: base.number,
        },
      })
    : null;
  if (body.chatId && !chat)
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 },
    );
  if (body.action === "abort") {
    if (chat)
      await prisma.simulationEditChat.updateMany({
        where: { id: chat.id, state: { in: ["DISCUSSING", "THINKING"] } },
        data: { state: "ABORTED", plan: null },
      });
    return NextResponse.json({ aborted: true });
  }
  if (body.action === "apply") {
    const plan = simulationEditPlanSchema.safeParse(
      chat?.plan ? JSON.parse(chat.plan) : null,
    );
    if (
      !chat ||
      chat.state !== "DISCUSSING" ||
      !plan.success ||
      plan.data.questions.length ||
      !plan.data.revisionPrompt.trim()
    )
      return NextResponse.json(
        { error: "Finish discussing the revision first" },
        { status: 409 },
      );
    const guard = await guardText(
      plan.data.revisionPrompt,
      { surface: "simulation_feedback", id, userId: actor.userId },
      { requestPath: true },
    );
    if (guard.blocked)
      return NextResponse.json(
        { error: guard.message, guardrailEventId: guard.eventId },
        { status: 422 },
      );
    const confirmedChat = chat;
    try {
      const feedback = await prisma.$transaction(async (tx) => {
        const claimed = await tx.questionSimulation.updateMany({
          where: { id, status: "READY" },
          data: { status: "REVISING" },
        });
        if (!claimed.count) throw new Error("Revision already started");
        const claimedChat = await tx.simulationEditChat.updateMany({
          where: {
            id: confirmedChat.id,
            state: "DISCUSSING",
            updatedAt: confirmedChat.updatedAt,
          },
          data: { state: "APPLIED" },
        });
        if (!claimed.count || !claimedChat.count)
          throw new Error("Revision already started or conversation changed");
        return tx.simulationFeedback.create({
          data: {
            simulationId: id,
            authorUserId: actor.userId,
            feedback: plan.data.revisionPrompt,
            baseVersion: base.number,
            versionName: plan.data.name,
          },
        });
      });
      try {
        enqueueSimulation(id, feedback.id);
      } catch {
        await prisma.$transaction([
          prisma.questionSimulation.update({
            where: { id },
            data: { status: "READY" },
          }),
          prisma.simulationFeedback.update({
            where: { id: feedback.id },
            data: {
              status: "FAILED",
              errorMessage: "Could not queue revision. Please retry.",
            },
          }),
          prisma.simulationEditChat.update({
            where: { id: chat.id },
            data: { state: "DISCUSSING" },
          }),
        ]);
        return NextResponse.json(
          { error: "Could not queue revision. Please retry." },
          { status: 503 },
        );
      }
      return NextResponse.json({ status: "REVISING" }, { status: 202 });
    } catch {
      return NextResponse.json(
        { error: "Revision already started or conversation changed" },
        { status: 409 },
      );
    }
  }
  // Both halves of the chat's configuration start empty on a fresh install, so
  // say which one is missing instead of failing later as an opaque model error.
  if (!settings.enabled)
    return NextResponse.json(
      { error: "Enable Simulation editing assistant in AI Config first" },
      { status: 409 },
    );
  if (!(await resolveProvider("simulation_chat")))
    return NextResponse.json(
      { error: "Assign a model to Simulation Editing Chat in AI Config first" },
      { status: 409 },
    );
  if (!body.message)
    return NextResponse.json({ error: "Message required" }, { status: 400 });
  const guard = await guardText(
    body.message,
    { surface: "simulation_feedback", id, userId: actor.userId },
    { requestPath: true },
  );
  if (guard.blocked)
    return NextResponse.json(
      { error: guard.message, guardrailEventId: guard.eventId },
      { status: 422 },
    );
  if (!chat)
    chat = await prisma.simulationEditChat.create({
      data: {
        simulationId: id,
        userId: actor.userId,
        baseVersion: base.number,
      },
    });
  const claimed = await prisma.simulationEditChat.updateMany({
    where: { id: chat.id, state: "DISCUSSING", updatedAt: chat.updatedAt },
    data: { state: "THINKING" },
  });
  if (!claimed.count)
    return NextResponse.json(
      { error: "Conversation is busy or closed; start a new conversation" },
      { status: 409 },
    );
  try {
    const [html, catalogue] = await Promise.all([
      getS3ObjectAsString(base.bucket, base.storageKey),
      listSimulationVersions(sim),
    ]);
    const history: AssistantTurn[] = JSON.parse(chat.transcript);
    const result = await runAssistantTurn({
      settings,
      ctx: {
        audience: "simulation",
        userId: actor.userId,
        teacherId: null,
        studentId: null,
      },
      history,
      message: body.message,
      attachments: [],
      notices: [
        fenceUntrusted(
          "version catalogue",
          JSON.stringify(
            catalogue.slice(-200).map(({ number, name, parentNumber }) => ({
              number,
              name,
              parentNumber,
            })),
          ),
        ),
        `Selected version v${base.number}. ${fenceUntrusted("simulation context", JSON.stringify({ name: base.name, topic: sim.topic, goal: sim.learningGoal, html: html.slice(0, 60000) }))}`,
      ],
      emit: () => {},
      signal: AbortSignal.timeout(120_000),
    });
    const plan = simulationEditPlanSchema.parse(
      JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, "")),
    );
    if (plan.showVersion) {
      if (!catalogue.some((v) => v.number === plan.showVersion))
        throw new Error("Assistant selected an unknown version");
      plan.questions = [];
      plan.revisionPrompt = "";
    }
    const saved = await prisma.simulationEditChat.updateMany({
      where: { id: chat.id, state: "THINKING" },
      data: {
        state: "DISCUSSING",
        plan: JSON.stringify(plan),
        transcript: JSON.stringify([
          ...history.slice(-settings.maxHistoryMessages),
          { role: "user", content: body.message },
          { role: "assistant", content: JSON.stringify(plan) },
        ]),
      },
    });
    return NextResponse.json(
      saved.count
        ? { chatId: chat.id, plan, showVersion: plan.showVersion }
        : { aborted: true },
    );
  } catch (error) {
    console.error("Simulation chat failed", error);
    await prisma.simulationEditChat.updateMany({
      where: { id: chat.id, state: "THINKING" },
      data: { state: "DISCUSSING" },
    });
    return NextResponse.json(
      {
        error:
          "The assistant could not prepare a response. Check its model configuration or retry.",
      },
      { status: 502 },
    );
  }
}
