// Impure orchestration for the per-question simulation feature: resolves the
// simulation_generation provider, runs the triage call (helpful? duplicate?
// build spec), generates/revises the self-contained HTML artifact, validates
// it, and persists it to S3 + the QuestionSimulation row. Runs in the
// background worker. All DB / LLM / S3 access is concentrated here; the pure
// prompts / schemas / validators live in `simulation.ts`.
//
// Generation is two calls with a leakage firewall between them: the triage
// call sees the question and writes a question-detail-free build spec; the
// HTML call sees ONLY that spec. A generated document that fails the static
// validator gets exactly one repair round before the job is marked FAILED.

import type OpenAI from "openai";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import {
  resolveProvider,
  createOpenAIClient,
  thinkingParams,
  type ResolvedProvider,
  type ThinkingParams,
} from "./ai-provider";
import {
  getS3Config,
  putS3Object,
  getS3ObjectAsString,
  buildSimulationKey,
} from "./storage";
import { retryWithExponentialBackoff } from "./retry";
import {
  streamChatCompletion,
  streamJsonCompletion,
  streamOptionsFor,
  transportFor,
  type AiTransport,
  type AiCallMetrics,
} from "./ai-streaming";
import { buildSimulationMetrics } from "./simulation-metrics";
import {
  SIMULATION_TRIAGE_SCHEMA,
  buildTriagePrompt,
  buildSimulationHtmlPrompt,
  buildRevisionPrompt,
  buildRepairPrompt,
  validateTriagePlan,
  extractHtmlDocument,
  validateSimulationHtml,
  type SimulationQuestionInput,
  type SiblingSimulation,
} from "./simulation";

function providerUsable(
  provider: ResolvedProvider | null,
): provider is ResolvedProvider {
  if (!provider) return false;
  if (provider.providerType !== "local" && !provider.apiKey) return false;
  if (
    (provider.providerType === "local" ||
      provider.providerType === "cloudflare") &&
    !provider.baseUrl
  ) {
    return false;
  }
  return true;
}

const NO_PROVIDER_MESSAGE =
  "No AI provider assigned to simulation_generation. An admin must configure the 'simulation_generation' use case in the AI Config dashboard.";

type CallContext = {
  client: OpenAI;
  model: string;
  providerType: ResolvedProvider["providerType"];
  serviceTier: string | null;
  tierActive: boolean;
  /** Reasoning effort pinned on the model, or null. Persisted with the metrics. */
  thinkingLevel: string | null;
  /** `reasoning_effort` fragment; empty unless the model has a level pinned. */
  thinking: ThinkingParams;
  isLocal: boolean;
  transport: AiTransport;
};

async function buildCallContext(
  provider: ResolvedProvider,
): Promise<CallContext> {
  const client = await createOpenAIClient(provider);
  const isLocal = provider.providerType === "local";
  const transport = transportFor(provider);
  const serviceTier = provider.serviceTier;
  const tierActive =
    !isLocal &&
    (serviceTier === "auto" ||
      serviceTier === "default" ||
      serviceTier === "flex");
  return {
    client,
    model: provider.model,
    providerType: provider.providerType,
    serviceTier,
    tierActive,
    thinkingLevel: provider.thinkingLevel,
    thinking: thinkingParams(provider),
    isLocal,
    transport,
  };
}

function tierParam(ctx: CallContext) {
  return ctx.tierActive ? (ctx.serviceTier as never) : undefined;
}

/**
 * One plain streamed text call (wrapped in the shared retry). Used for the
 * HTML build/revision/repair calls, which return a raw document rather than
 * JSON. Throws on an empty response.
 */
async function callTextModel(
  ctx: CallContext,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): Promise<{ text: string; metrics: AiCallMetrics }> {
  const result = await retryWithExponentialBackoff(() =>
    streamChatCompletion(
      ctx.client,
      {
        model: ctx.model,
        messages,
        service_tier: tierParam(ctx),
        ...ctx.thinking,
      },
      streamOptionsFor(ctx.transport),
    ),
  );
  if (!result.text.trim()) throw new Error("Model returned an empty response");
  return result;
}

/**
 * Generate one HTML document from a starting prompt, giving the model exactly
 * one repair round when the static validator rejects its first attempt.
 * Returns the validated document; throws (with the validator's reasons) when
 * the repair also fails.
 */
async function generateValidatedHtml(
  ctx: CallContext,
  prompt: string,
  callMetrics: AiCallMetrics[],
): Promise<string> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "user", content: prompt },
  ];
  const first = await callTextModel(ctx, messages);
  callMetrics.push(first.metrics);

  let html = extractHtmlDocument(first.text);
  let problems = validateSimulationHtml(html);
  if (problems.length === 0) return html;

  console.warn(
    `[Simulation] Generated document failed validation (${problems.join("; ")}); repairing`,
  );
  const repair = await callTextModel(ctx, [
    ...messages,
    { role: "assistant", content: first.text },
    { role: "user", content: buildRepairPrompt(problems) },
  ]);
  callMetrics.push(repair.metrics);

  html = extractHtmlDocument(repair.text);
  problems = validateSimulationHtml(html);
  if (problems.length > 0) {
    throw new Error(
      `Generated document failed validation after repair: ${problems.join("; ")}`,
    );
  }
  return html;
}

/**
 * Run one simulation job and persist the result.
 *
 * Idempotent + self-healing, mirroring runQuizExtraction: a fresh generation
 * only acts on a row in PENDING, a revision (feedbackId set) only on REVISING,
 * so Honker redelivery after a worker restart is safe. Environment gaps and
 * any thrown error are recorded on the row (FAILED for a first generation;
 * back to READY with the feedback row FAILED for a revision, so the existing
 * artifact keeps serving) and the function RETURNS — it never rethrows, so the
 * worker can ack unconditionally.
 */
export async function runSimulationJob(
  simulationId: string,
  feedbackId?: string,
): Promise<void> {
  const sim = await prisma.questionSimulation.findUnique({
    where: { id: simulationId },
    include: {
      question: {
        include: {
          options: { orderBy: { id: "asc" } },
          quiz: { include: { topic: true } },
        },
      },
    },
  });

  if (!sim) {
    console.warn(
      `[Simulation] Simulation ${simulationId} not found; nothing to do`,
    );
    return;
  }

  if (feedbackId) {
    await runRevision(sim, feedbackId);
  } else {
    await runFirstGeneration(sim);
  }
}

type LoadedSimulation = Prisma.QuestionSimulationGetPayload<{
  include: {
    question: {
      include: {
        options: true;
        quiz: { include: { topic: true } };
      };
    };
  };
}>;

function questionInput(sim: LoadedSimulation): SimulationQuestionInput {
  return {
    text: sim.question.text,
    answerMode: sim.question.answerMode,
    options: sim.question.options.map((o) => ({ text: o.text })),
    figureAlt: sim.question.figureAlt,
    quizName: sim.question.quiz.name,
    topicName: sim.question.quiz.topic?.name ?? null,
  };
}

async function runFirstGeneration(sim: LoadedSimulation): Promise<void> {
  if (sim.status !== "PENDING") {
    console.log(
      `[Simulation] ${sim.id} is in status ${sim.status}, not PENDING; skipping`,
    );
    return;
  }

  try {
    const provider = await resolveProvider("simulation_generation");
    if (!providerUsable(provider)) {
      await prisma.questionSimulation.update({
        where: { id: sim.id },
        data: { status: "FAILED", errorMessage: NO_PROVIDER_MESSAGE },
      });
      console.error(`[Simulation] No usable provider for simulation ${sim.id}`);
      return;
    }
    const ctx = await buildCallContext(provider);
    const callMetrics: AiCallMetrics[] = [];

    // Sibling sims in the same quiz that already carry an artifact — the
    // triage call may point at one instead of building a near-duplicate.
    const siblingRows = await prisma.questionSimulation.findMany({
      where: {
        id: { not: sim.id },
        status: "READY",
        storageKey: { not: null },
        topic: { not: null },
        question: { quizId: sim.question.quizId },
      },
      orderBy: { createdAt: "asc" },
    });
    const siblings: SiblingSimulation[] = siblingRows.map((s) => ({
      topic: s.topic ?? "",
      title: s.title ?? "",
    }));

    // ── Triage: decline, duplicate, or build spec. ──
    const triage = await retryWithExponentialBackoff(() =>
      streamJsonCompletion(
        ctx.client,
        {
          model: ctx.model,
          messages: [
            {
              role: "user",
              content: buildTriagePrompt(questionInput(sim), siblings),
            },
          ],
          service_tier: tierParam(ctx),
          ...ctx.thinking,
        },
        SIMULATION_TRIAGE_SCHEMA,
        streamOptionsFor(ctx.transport),
      ),
    );
    callMetrics.push(triage.metrics);
    const plan = validateTriagePlan(triage.value, siblings.length);

    if (!plan.helpful) {
      await prisma.questionSimulation.update({
        where: { id: sim.id },
        data: {
          status: "DECLINED",
          declineReason: plan.refusalReason,
          errorMessage: null,
          ...buildSimulationMetrics(ctx, callMetrics),
        },
      });
      console.log(`[Simulation] ${sim.id} declined: ${plan.refusalReason}`);
      return;
    }

    if (plan.duplicateOfIndex !== null) {
      const source = siblingRows[plan.duplicateOfIndex];
      await prisma.questionSimulation.update({
        where: { id: sim.id },
        data: {
          status: "READY",
          topic: source.topic,
          title: source.title,
          learningGoal: source.learningGoal,
          simSpec: source.simSpec,
          // Shared immutable object, exactly like figure keys on deep copy. A
          // later revision of either row writes its own new key.
          storageKey: source.storageKey,
          bucket: source.bucket,
          declineReason: null,
          errorMessage: null,
          ...buildSimulationMetrics(ctx, callMetrics),
        },
      });
      console.log(
        `[Simulation] ${sim.id} reuses sibling ${source.id} (${source.topic})`,
      );
      return;
    }

    // ── Build: generate the artifact from the spec only. ──
    const html = await generateValidatedHtml(
      ctx,
      buildSimulationHtmlPrompt(plan),
      callMetrics,
    );

    const { bucket } = getS3Config();
    const version = sim.version + 1;
    const key = buildSimulationKey(
      sim.question.quiz.teacherId,
      sim.question.quizId,
      sim.questionId,
      version,
    );
    await putS3Object(bucket, key, html, "text/html; charset=utf-8");

    await prisma.questionSimulation.update({
      where: { id: sim.id },
      data: {
        status: "READY",
        topic: plan.topic,
        title: plan.title,
        learningGoal: plan.learningGoal,
        simSpec: plan.spec,
        storageKey: key,
        bucket,
        version,
        declineReason: null,
        errorMessage: null,
        ...buildSimulationMetrics(ctx, callMetrics),
      },
    });
    console.log(
      `[Simulation] ${sim.id} ready: "${plan.title}" (${plan.topic}) v${version}`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message.trim() : String(err).trim();
    console.error(`[Simulation] Generation for ${sim.id} failed:`, message);
    try {
      await prisma.questionSimulation.update({
        where: { id: sim.id },
        data: {
          status: "FAILED",
          errorMessage: message || "Unknown error during simulation generation",
        },
      });
    } catch (dbErr) {
      console.error(
        `[Simulation] Could not mark simulation ${sim.id} FAILED:`,
        dbErr,
      );
    }
  }
}

async function runRevision(
  sim: LoadedSimulation,
  feedbackId: string,
): Promise<void> {
  if (sim.status !== "REVISING") {
    console.log(
      `[Simulation] ${sim.id} is in status ${sim.status}, not REVISING; skipping revision`,
    );
    return;
  }

  // Failure handling for the revision path: the previous artifact is intact,
  // so the sim goes BACK to READY (it keeps serving) and the failure is
  // recorded on the feedback row.
  const failRevision = async (message: string) => {
    console.error(
      `[Simulation] Revision ${feedbackId} for ${sim.id} failed:`,
      message,
    );
    try {
      await prisma.simulationFeedback.updateMany({
        where: { id: feedbackId, simulationId: sim.id },
        data: {
          status: "FAILED",
          errorMessage: message || "Unknown error during revision",
        },
      });
      await prisma.questionSimulation.update({
        where: { id: sim.id },
        data: { status: sim.storageKey ? "READY" : "FAILED" },
      });
    } catch (dbErr) {
      console.error(
        `[Simulation] Could not record revision failure for ${sim.id}:`,
        dbErr,
      );
    }
  };

  try {
    const feedback = await prisma.simulationFeedback.findUnique({
      where: { id: feedbackId },
    });
    if (!feedback || feedback.simulationId !== sim.id) {
      await failRevision("Feedback row not found for this simulation");
      return;
    }
    if (feedback.status !== "PENDING") {
      // Stale redelivery of an already-applied/failed round; put the sim back.
      console.log(
        `[Simulation] Feedback ${feedbackId} is ${feedback.status}, not PENDING; skipping`,
      );
      await prisma.questionSimulation.update({
        where: { id: sim.id },
        data: { status: sim.storageKey ? "READY" : "FAILED" },
      });
      return;
    }
    if (
      !sim.storageKey ||
      !sim.bucket ||
      !sim.simSpec ||
      !sim.topic ||
      !sim.title
    ) {
      await failRevision("Simulation has no artifact/spec to revise");
      return;
    }

    const provider = await resolveProvider("simulation_generation");
    if (!providerUsable(provider)) {
      await failRevision(NO_PROVIDER_MESSAGE);
      return;
    }
    const ctx = await buildCallContext(provider);
    const callMetrics: AiCallMetrics[] = [];

    const currentHtml = await getS3ObjectAsString(sim.bucket, sim.storageKey);
    const applied = await prisma.simulationFeedback.findMany({
      where: { simulationId: sim.id, status: "APPLIED" },
      orderBy: { createdAt: "asc" },
    });

    const plan = {
      topic: sim.topic,
      title: sim.title,
      learningGoal: sim.learningGoal ?? "",
      spec: sim.simSpec,
    };
    const priorFeedback = applied.map((f) => f.feedback);
    const prompt = buildRevisionPrompt(
      plan,
      currentHtml,
      priorFeedback,
      feedback.feedback,
    );
    // One quality-focused generation call replaces the former generate +
    // independent confirmation flow. The prompt carries the full integrity
    // checklist; deterministic HTML validation (and its one repair fallback)
    // still runs before anything is published.
    const html = await generateValidatedHtml(ctx, prompt, callMetrics);

    const { bucket } = getS3Config();
    const version = sim.version + 1;
    const key = buildSimulationKey(
      sim.question.quiz.teacherId,
      sim.question.quizId,
      sim.questionId,
      version,
    );
    await putS3Object(bucket, key, html, "text/html; charset=utf-8");

    await prisma.$transaction([
      prisma.questionSimulation.update({
        where: { id: sim.id },
        data: {
          status: "READY",
          storageKey: key,
          bucket,
          version,
          errorMessage: null,
          ...buildSimulationMetrics(ctx, callMetrics),
        },
      }),
      prisma.simulationFeedback.update({
        where: { id: feedback.id },
        data: {
          status: "APPLIED",
          errorMessage: null,
          previousStorageKey: sim.storageKey,
        },
      }),
    ]);
    console.log(
      `[Simulation] ${sim.id} revised to v${version} (feedback ${feedback.id})`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message.trim() : String(err).trim();
    await failRevision(message);
  }
}
