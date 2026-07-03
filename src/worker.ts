import honker from "@russellthehippo/honker-node";
import { processMaterial } from "./lib/vlm-engine";
import { prisma } from "./lib/prisma";
import { generateExamResult } from "./lib/exam-results-engine";
import { runQuizExtraction } from "./lib/quiz-extraction-engine";
import { runSimulationJob } from "./lib/simulation-engine";
import {
  EXAM_RESULTS_QUEUE,
  QUIZ_EXTRACTIONS_QUEUE,
  BACKUPS_QUEUE,
  SIMULATIONS_QUEUE,
  enqueueBackup,
  resolveQueueDbPath,
  type ExamResultsJobPayload,
  type QuizExtractionJobPayload,
  type SimulationJobPayload,
} from "./lib/queue";
import { runBackupJob, claimDueBackup } from "./lib/backup";

// Honker opens its own SQLite file (a sibling of the Prisma DB); see
// resolveQueueDbPath for why the queue never shares the app's database.
const dbPath = resolveQueueDbPath();

console.log(`[Worker] Connecting to SQLite at ${dbPath}`);

const db = honker.open(dbPath);
const materialsQueue = db.queue("materials");
const examResultsQueue = db.queue(EXAM_RESULTS_QUEUE);
const quizExtractionsQueue = db.queue(QUIZ_EXTRACTIONS_QUEUE);
const backupsQueue = db.queue(BACKUPS_QUEUE);
const simulationsQueue = db.queue(SIMULATIONS_QUEUE);

async function consumeMaterials() {
  console.log("[Worker] Starting Honker queue consumer for 'materials'...");
  for await (const job of materialsQueue.claim("worker-1")) {
    const payload = job.payload as { materialId: string };
    const materialId = payload.materialId;
    console.log(`[Worker] Picked up job ${job.id} for material ${materialId}`);
    try {
      await processMaterial(materialId);
      job.ack();
      console.log(`[Worker] Successfully processed and acked job ${job.id}`);
    } catch (err: any) {
      console.error(`[Worker] Error processing job ${job.id}:`, err.message);

      // Mark material as FAILED in the database if processMaterial threw an unhandled error
      try {
        await prisma.learningMaterial.update({
          where: { id: materialId },
          data: {
            processingStatus: "FAILED",
            errorMessage: err.message || "Unknown error during background processing",
          },
        });
      } catch (dbErr) {
        console.error(`[Worker] Could not update material status to FAILED:`, dbErr);
      }

      // Ack the job so it doesn't block the queue with infinite retries on permanent failures
      job.ack();
    }
  }
}

async function consumeExamResults() {
  console.log(`[Worker] Starting Honker queue consumer for '${EXAM_RESULTS_QUEUE}'...`);
  for await (const job of examResultsQueue.claim("exam-results-worker")) {
    const { examResultId } = job.payload as ExamResultsJobPayload;
    console.log(`[Worker] Picked up job ${job.id} for exam result ${examResultId}`);
    try {
      // generateExamResult is idempotent + records per-section FAILED states
      // internally, so it always returns; ack unconditionally to avoid blocking.
      await generateExamResult(examResultId);
      console.log(`[Worker] Finished exam-result job ${job.id}`);
    } catch (err: any) {
      console.error(`[Worker] Error on exam-result job ${job.id}:`, err?.message ?? err);
    } finally {
      job.ack();
    }
  }
}

async function consumeQuizExtractions() {
  console.log(`[Worker] Starting Honker queue consumer for '${QUIZ_EXTRACTIONS_QUEUE}'...`);
  for await (const job of quizExtractionsQueue.claim("quiz-extraction-worker")) {
    const { extractionId } = job.payload as QuizExtractionJobPayload;
    console.log(`[Worker] Picked up job ${job.id} for quiz extraction ${extractionId}`);
    try {
      // runQuizExtraction is idempotent + records FAILED internally, so it
      // always returns; ack unconditionally to avoid blocking the queue.
      await runQuizExtraction(extractionId);
      console.log(`[Worker] Finished quiz-extraction job ${job.id}`);
    } catch (err: any) {
      console.error(`[Worker] Error on quiz-extraction job ${job.id}:`, err?.message ?? err);
    } finally {
      job.ack();
    }
  }
}

async function consumeSimulations() {
  console.log(`[Worker] Starting Honker queue consumer for '${SIMULATIONS_QUEUE}'...`);
  for await (const job of simulationsQueue.claim("simulations-worker")) {
    const { simulationId, feedbackId } = job.payload as SimulationJobPayload;
    console.log(
      `[Worker] Picked up job ${job.id} for simulation ${simulationId}${feedbackId ? ` (feedback ${feedbackId})` : ""}`
    );
    try {
      // runSimulationJob is idempotent + records FAILED internally, so it
      // always returns; ack unconditionally to avoid blocking the queue.
      await runSimulationJob(simulationId, feedbackId);
      console.log(`[Worker] Finished simulation job ${job.id}`);
    } catch (err: any) {
      console.error(`[Worker] Error on simulation job ${job.id}:`, err?.message ?? err);
    } finally {
      job.ack();
    }
  }
}

async function consumeBackups() {
  console.log(`[Worker] Starting Honker queue consumer for '${BACKUPS_QUEUE}'...`);
  for await (const job of backupsQueue.claim("backups-worker")) {
    console.log(`[Worker] Picked up backup job ${job.id}`);
    try {
      const result = await runBackupJob();
      console.log(
        `[Worker] Backup complete: ${result.key} (pruned ${result.pruned.length})`,
      );
    } catch (err: any) {
      console.error(`[Worker] Backup job ${job.id} failed:`, err?.message ?? err);
    } finally {
      // Ack regardless — runBackupJob records FAILED status itself; a stuck job
      // must not block the queue.
      job.ack();
    }
  }
}

/**
 * Config-driven scheduler: every minute, ask backup.ts whether a scheduled
 * backup is due (advancing nextRunAt so we never double-enqueue) and, if so,
 * enqueue one. Reads the live BackupConfig each tick, so admin changes to the
 * interval/anchor take effect immediately.
 */
async function runBackupScheduler() {
  console.log("[Worker] Backup scheduler tick started (60s interval)...");
  for (;;) {
    try {
      if (await claimDueBackup()) {
        console.log("[Worker] Scheduled backup due — enqueueing");
        enqueueBackup();
      }
    } catch (err: any) {
      console.error("[Worker] Backup scheduler tick error:", err?.message ?? err);
    }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

async function startWorker() {
  try {
    // Run all consumers + the scheduler concurrently; each blocks on its own loop.
    await Promise.all([
      consumeMaterials(),
      consumeExamResults(),
      consumeQuizExtractions(),
      consumeSimulations(),
      consumeBackups(),
      runBackupScheduler(),
    ]);
  } catch (err) {
    console.error("[Worker] Fatal error in worker loop:", err);
    process.exit(1);
  }
}

startWorker();
