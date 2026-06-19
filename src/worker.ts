import honker from "@russellthehippo/honker-node";
import path from "path";
import { processMaterial } from "./lib/vlm-engine";
import { prisma } from "./lib/prisma";
import { generateExamResult } from "./lib/exam-results-engine";
import { runQuizExtraction } from "./lib/quiz-extraction-engine";
import {
  EXAM_RESULTS_QUEUE,
  QUIZ_EXTRACTIONS_QUEUE,
  BACKUPS_QUEUE,
  enqueueBackup,
  type ExamResultsJobPayload,
  type QuizExtractionJobPayload,
} from "./lib/queue";
import { runBackupJob, claimDueBackup } from "./lib/backup";

// Parse DATABASE_URL from process.env
const dbUrl = process.env.DATABASE_URL || "file:./dev.db";
let dbPath = dbUrl.replace("file:", "").split("?")[0];

// Prisma resolves file:./... relative to the prisma directory.
// The worker is typically run from the project root.
if (dbPath === "./dev.db") {
  dbPath = path.join(process.cwd(), "prisma", "dev.db");
} else if (dbPath === "./data/prod.db") {
  dbPath = path.join(process.cwd(), "prisma", "data", "prod.db");
} else if (!path.isAbsolute(dbPath)) {
  dbPath = path.join(process.cwd(), "prisma", dbPath);
}

console.log(`[Worker] Connecting to SQLite at ${dbPath}`);

const db = honker.open(dbPath);
const materialsQueue = db.queue("materials");
const examResultsQueue = db.queue(EXAM_RESULTS_QUEUE);
const quizExtractionsQueue = db.queue(QUIZ_EXTRACTIONS_QUEUE);
const backupsQueue = db.queue(BACKUPS_QUEUE);

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
      consumeBackups(),
      runBackupScheduler(),
    ]);
  } catch (err) {
    console.error("[Worker] Fatal error in worker loop:", err);
    process.exit(1);
  }
}

startWorker();
