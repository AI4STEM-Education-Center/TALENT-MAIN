import honker from "@russellthehippo/honker-node";
import path from "path";
import { processMaterial } from "./lib/vlm-engine";
import { prisma } from "./lib/prisma";
import { generateExamResult } from "./lib/exam-results-engine";
import { runQuizExtraction } from "./lib/quiz-extraction-engine";
import {
  EXAM_RESULTS_QUEUE,
  QUIZ_EXTRACTIONS_QUEUE,
  type ExamResultsJobPayload,
  type QuizExtractionJobPayload,
} from "./lib/queue";

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

async function startWorker() {
  try {
    // Run all consumers concurrently; each blocks on its own queue.
    await Promise.all([consumeMaterials(), consumeExamResults(), consumeQuizExtractions()]);
  } catch (err) {
    console.error("[Worker] Fatal error in worker loop:", err);
    process.exit(1);
  }
}

startWorker();
