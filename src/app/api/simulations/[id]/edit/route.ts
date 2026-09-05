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
import { getS3ObjectAsString } from "@/lib/storage";
import { fenceUntrusted } from "@/lib/guardrail-fence";
import { guardText } from "@/lib/guardrail-runner";
import { rateLimit } from "@/lib/rate-limit";
import { enqueueSimulation } from "@/lib/queue";

export const runtime = "nodejs";
const inputSchema = z.object({
  action: z.enum(["chat", "apply", "restore", "abort", "rename"]),
  version: z.number().int().positive(),
  chatId: z.string().optional(),
  message: z.string().trim().min(1).max(4000).optional(),
  name: z.string().trim().min(1).max(80).optional(),
});
async function access(id: string) {
  const actor = await getContentActor();
  if (!actor) return null;
  const sim = await prisma.questionSimulation.findUnique({
    where: { id },
    include: {
      question: { select: { quiz: { select: { teacherId: true } } } },
    },
  });
  return sim && canManage(actor, sim.question.quiz) ? { actor, sim } : null;
}
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const found = await access(id);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [versions, chats] = await Promise.all([
    listSimulationVersions(found.sim),
    prisma.simulationEditChat.findMany({
      where: { simulationId: id, userId: found.actor.userId },
      orderBy: { updatedAt: "desc" },
      take: 30,
    }),
  ]);
  return NextResponse.json({
    versions: versions.map(({ number, name, parentNumber, createdAt }) => ({
      number,
      name,
      parentNumber,
      createdAt,
    })),
    chats,
    activeVersion: found.sim.version,
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
  if (!settings.enabled)
    return NextResponse.json(
      { error: "Enable Simulation editing assistant in AI Config first" },
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
            catalogue
              .slice(-200)
              .map(({ number, name, parentNumber }) => ({
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
