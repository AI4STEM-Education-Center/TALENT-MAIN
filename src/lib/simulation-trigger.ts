import { prisma } from "@/lib/prisma";
import { enqueueSimulation } from "@/lib/queue";

// Statuses that a plain (non-force) trigger re-enqueues. READY/DECLINED are
// terminal decisions; PENDING/REVISING are already in flight.
const RETRYABLE = new Set(["FAILED"]);
const IN_FLIGHT = new Set(["PENDING", "REVISING"]);

export type TriggerSummary = {
  totalQuestions: number;
  created: number;
  retried: number;
  skipped: number;
  enqueued: number;
  enqueueFailed: number;
};

/**
 * Create/reset the QuestionSimulation rows for `questionIds` and enqueue a
 * generation job for each. Shared by the admin pool dashboard and the teacher
 * quiz editor so both scopes behave identically.
 *
 * Missing rows are created and FAILED ones re-enqueued; READY, DECLINED and
 * in-flight rows are skipped unless `force`. Callers only pass force for a
 * single question, so a whole-quiz trigger can never discard settled work.
 */
export async function triggerSimulations(
  questionIds: string[],
  force = false
): Promise<TriggerSummary> {
  const existing = await prisma.questionSimulation.findMany({
    where: { questionId: { in: questionIds } },
  });
  const byQuestionId = new Map(existing.map((s) => [s.questionId, s]));

  let created = 0;
  let retried = 0;
  let skipped = 0;
  const toEnqueue: string[] = [];

  for (const questionId of questionIds) {
    const sim = byQuestionId.get(questionId);
    if (!sim) {
      // No skipDuplicates on SQLite; a concurrent trigger may have created the
      // row between the read above and here, so treat a unique violation as a
      // skip rather than failing the whole batch.
      try {
        const row = await prisma.questionSimulation.create({ data: { questionId } });
        created += 1;
        toEnqueue.push(row.id);
      } catch {
        skipped += 1;
      }
      continue;
    }
    // force also rescues a row stuck PENDING/REVISING after a dead worker:
    // resetting to PENDING makes any stale redelivery a no-op for the old job
    // while the new one regenerates from scratch.
    if (IN_FLIGHT.has(sim.status) && !force) {
      skipped += 1;
      continue;
    }
    if (RETRYABLE.has(sim.status) || force) {
      const claimed = await prisma.questionSimulation.updateMany({
        where: { id: sim.id, updatedAt: sim.updatedAt },
        data: {
          status: "PENDING",
          errorMessage: null,
          aiModel: null,
          aiProvider: null,
          aiServiceTier: null,
          aiTtftMs: null,
          aiGenerationMs: null,
          aiTotalMs: null,
          aiTokens: null,
          aiTokensEstimated: null,
        },
      });
      if (claimed.count !== 1) {
        skipped += 1;
        continue;
      }
      retried += 1;
      toEnqueue.push(sim.id);
      continue;
    }
    skipped += 1;
  }

  // The job is the feature: an enqueue failure marks that row FAILED so it is
  // visible (and retryable) in the dashboard instead of stuck PENDING forever.
  let enqueueFailed = 0;
  for (const simulationId of toEnqueue) {
    try {
      enqueueSimulation(simulationId);
    } catch (e) {
      enqueueFailed += 1;
      const errorMessage = e instanceof Error ? e.message : "Failed to enqueue simulation job";
      await prisma.questionSimulation
        .update({ where: { id: simulationId }, data: { status: "FAILED", errorMessage } })
        .catch(() => {});
    }
  }

  return {
    totalQuestions: questionIds.length,
    created,
    retried,
    skipped,
    enqueued: toEnqueue.length - enqueueFailed,
    enqueueFailed,
  };
}
