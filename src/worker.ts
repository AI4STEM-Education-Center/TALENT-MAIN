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
  MESSAGE_EMAILS_QUEUE,
  MESSAGE_EMAILS_QUEUE_OPTIONS,
  CONSENT_EMAILS_QUEUE,
  CONSENT_EXPORTS_QUEUE,
  enqueueBackup,
  type BackupJobPayload,
  enqueueMessageEmails,
  resolveQueueDbPath,
  type ExamResultsJobPayload,
  type QuizExtractionJobPayload,
  type SimulationJobPayload,
  type MessageEmailJobPayload,
  type ConsentEmailJobPayload,
  type ConsentExportJobPayload,
} from "./lib/queue";
import {
  deliverMessageEmail,
  failExhaustedMessageEmails,
  findStrandedMessageEmails,
} from "./lib/message-email";
import {
  deliverConsentEmail,
  failExhaustedConsentEmails,
  findStrandedConsentEmails,
} from "./lib/consent-email";
import {
  runConsentExportJob,
  sweepExpiredConsentExports,
} from "./lib/consent-export";
import { runBackupJob, claimDueBackup } from "./lib/backup";
import { runS3Gc } from "./lib/s3-gc";
import { purgeExpiredAssistantAttachments } from "./lib/assistant/attachment-store";
import {
  archiveAgedConversations,
  historyCutoff,
  purgeEmptyConversations,
} from "./lib/assistant/conversation-store";
import { getAssistantSettings } from "./lib/assistant/config";
import { ASSISTANT_AUDIENCES } from "./lib/assistant/types";
import {
  pruneResourceSamples,
  startResourceSampler,
  RESOURCE_SAMPLE_RETENTION_DAYS,
} from "./lib/resource-monitor";
import { logSystemEvent } from "./lib/system-log";

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
const messageEmailsQueue = db.queue(
  MESSAGE_EMAILS_QUEUE,
  MESSAGE_EMAILS_QUEUE_OPTIONS,
);
const consentEmailsQueue = db.queue(CONSENT_EMAILS_QUEUE);
const consentExportsQueue = db.queue(CONSENT_EXPORTS_QUEUE);

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
      await logSystemEvent({
        category: "WORKER",
        type: "JOB_FAILED",
        severity: "ERROR",
        message: `Material processing job failed: ${err.message ?? err}`,
        metadata: { queue: "materials", jobId: job.id, materialId },
      });

      // Mark material as FAILED in the database if processMaterial threw an unhandled error
      try {
        await prisma.learningMaterial.update({
          where: { id: materialId },
          data: {
            processingStatus: "FAILED",
            errorMessage:
              err.message || "Unknown error during background processing",
          },
        });
      } catch (dbErr) {
        console.error(
          `[Worker] Could not update material status to FAILED:`,
          dbErr,
        );
      }

      // Ack the job so it doesn't block the queue with infinite retries on permanent failures
      job.ack();
    }
  }
}

async function consumeExamResults() {
  console.log(
    `[Worker] Starting Honker queue consumer for '${EXAM_RESULTS_QUEUE}'...`,
  );
  for await (const job of examResultsQueue.claim("exam-results-worker")) {
    const { examResultId } = job.payload as ExamResultsJobPayload;
    console.log(
      `[Worker] Picked up job ${job.id} for exam result ${examResultId}`,
    );
    try {
      // generateExamResult is idempotent + records per-section FAILED states
      // internally, so it always returns; ack unconditionally to avoid blocking.
      await generateExamResult(examResultId);
      console.log(`[Worker] Finished exam-result job ${job.id}`);
    } catch (err: any) {
      console.error(
        `[Worker] Error on exam-result job ${job.id}:`,
        err?.message ?? err,
      );
      await logSystemEvent({
        category: "WORKER",
        type: "JOB_FAILED",
        severity: "ERROR",
        message: `Exam-result job failed: ${err?.message ?? err}`,
        metadata: { queue: EXAM_RESULTS_QUEUE, jobId: job.id, examResultId },
      });
    } finally {
      job.ack();
    }
  }
}

async function consumeQuizExtractions() {
  console.log(
    `[Worker] Starting Honker queue consumer for '${QUIZ_EXTRACTIONS_QUEUE}'...`,
  );
  for await (const job of quizExtractionsQueue.claim(
    "quiz-extraction-worker",
  )) {
    const { extractionId } = job.payload as QuizExtractionJobPayload;
    console.log(
      `[Worker] Picked up job ${job.id} for quiz extraction ${extractionId}`,
    );
    try {
      // runQuizExtraction is idempotent + records FAILED internally, so it
      // always returns; ack unconditionally to avoid blocking the queue.
      await runQuizExtraction(extractionId);
      console.log(`[Worker] Finished quiz-extraction job ${job.id}`);
    } catch (err: any) {
      console.error(
        `[Worker] Error on quiz-extraction job ${job.id}:`,
        err?.message ?? err,
      );
      await logSystemEvent({
        category: "WORKER",
        type: "JOB_FAILED",
        severity: "ERROR",
        message: `Quiz-extraction job failed: ${err?.message ?? err}`,
        metadata: {
          queue: QUIZ_EXTRACTIONS_QUEUE,
          jobId: job.id,
          extractionId,
        },
      });
    } finally {
      job.ack();
    }
  }
}

async function consumeSimulations() {
  console.log(
    `[Worker] Starting Honker queue consumer for '${SIMULATIONS_QUEUE}'...`,
  );
  for await (const job of simulationsQueue.claim("simulations-worker")) {
    const { simulationId, feedbackId } = job.payload as SimulationJobPayload;
    console.log(
      `[Worker] Picked up job ${job.id} for simulation ${simulationId}${feedbackId ? ` (feedback ${feedbackId})` : ""}`,
    );
    try {
      // runSimulationJob is idempotent + records FAILED internally, so it
      // always returns; ack unconditionally to avoid blocking the queue.
      await runSimulationJob(simulationId, feedbackId);
      console.log(`[Worker] Finished simulation job ${job.id}`);
    } catch (err: any) {
      console.error(
        `[Worker] Error on simulation job ${job.id}:`,
        err?.message ?? err,
      );
      await logSystemEvent({
        category: "WORKER",
        type: "JOB_FAILED",
        severity: "ERROR",
        message: `Simulation job failed: ${err?.message ?? err}`,
        metadata: {
          queue: SIMULATIONS_QUEUE,
          jobId: job.id,
          simulationId,
          feedbackId,
        },
      });
    } finally {
      job.ack();
    }
  }
}

async function consumeMessageEmails() {
  console.log(
    `[Worker] Starting Honker queue consumer for '${MESSAGE_EMAILS_QUEUE}'...`,
  );
  for await (const job of messageEmailsQueue.claim("message-emails-worker")) {
    const { deliveryId } = job.payload as MessageEmailJobPayload;
    try {
      const result = await deliverMessageEmail(deliveryId);
      if (result.status === "RETRY") {
        // Transient SMTP trouble — hand the job back with the engine's backoff
        // so the same recipient is tried again instead of being dropped.
        console.warn(
          `[Worker] Message email ${deliveryId} failed (${result.error}); retrying in ${result.delaySeconds}s`,
        );
        job.retry(result.delaySeconds, result.error);
        continue;
      }
      if (result.status === "FAILED") {
        console.error(
          `[Worker] Message email ${deliveryId} gave up: ${result.error}`,
        );
        await logSystemEvent({
          category: "WORKER",
          type: "MESSAGE_EMAIL_FAILED",
          severity: "ERROR",
          message: `Message notification email gave up: ${result.error}`,
          metadata: { queue: MESSAGE_EMAILS_QUEUE, jobId: job.id, deliveryId },
        });
      }
      job.ack();
    } catch (err: any) {
      // Only the engine's own bookkeeping can land here (the send path is
      // already handled). Retry so a blip in the database doesn't drop the
      // email; the delivery row's attempt cap still bounds it.
      console.error(
        `[Worker] Error on message-email job ${job.id}:`,
        err?.message ?? err,
      );
      await logSystemEvent({
        category: "WORKER",
        type: "JOB_FAILED",
        severity: "ERROR",
        message: `Message-email job failed: ${err?.message ?? err}`,
        metadata: { queue: MESSAGE_EMAILS_QUEUE, jobId: job.id, deliveryId },
      });
      job.retry(60, String(err?.message ?? err));
    }
  }
}

// How often to look for delivery rows whose job never ran (enqueue failed, job
// lost, worker killed). This is the backstop that makes queued email delivery
// survive anything short of losing the database itself.
const MESSAGE_EMAIL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function runMessageEmailSweeper() {
  console.log("[Worker] Message-email sweeper started (5m interval)...");
  for (;;) {
    try {
      const stranded = await findStrandedMessageEmails();
      if (stranded.length > 0) {
        enqueueMessageEmails(stranded);
        console.log(
          `[Worker] Re-enqueued ${stranded.length} stranded message email(s)`,
        );
      }

      const exhausted = await failExhaustedMessageEmails();
      if (exhausted > 0) {
        console.log(
          `[Worker] Closed out ${exhausted} message email(s) that ran out of attempts`,
        );
      }
    } catch (err: any) {
      console.error(
        "[Worker] Message-email sweep failed:",
        err?.message ?? err,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, MESSAGE_EMAIL_SWEEP_INTERVAL_MS),
    );
  }
}

async function consumeConsentEmails() {
  console.log(
    `[Worker] Starting Honker queue consumer for '${CONSENT_EMAILS_QUEUE}'...`,
  );
  for await (const job of consentEmailsQueue.claim("consent-emails-worker")) {
    const { deliveryId } = job.payload as ConsentEmailJobPayload;
    try {
      const result = await deliverConsentEmail(deliveryId);
      if (result.status === "RETRY") {
        console.warn(
          `[Worker] Consent email ${deliveryId} failed (${result.error}); retrying in ${result.delaySeconds}s`,
        );
        job.retry(result.delaySeconds, result.error);
        continue;
      }
      if (result.status === "FAILED") {
        console.error(
          `[Worker] Consent email ${deliveryId} gave up: ${result.error}`,
        );
        await logSystemEvent({
          category: "WORKER",
          type: "CONSENT_EMAIL_FAILED",
          severity: "ERROR",
          message: `Consent email gave up: ${result.error}`,
          metadata: { queue: CONSENT_EMAILS_QUEUE, jobId: job.id, deliveryId },
        });
      }
      job.ack();
    } catch (err: any) {
      console.error(
        `[Worker] Error on consent-email job ${job.id}:`,
        err?.message ?? err,
      );
      await logSystemEvent({
        category: "WORKER",
        type: "JOB_FAILED",
        severity: "ERROR",
        message: `Consent-email job failed: ${err?.message ?? err}`,
        metadata: { queue: CONSENT_EMAILS_QUEUE, jobId: job.id, deliveryId },
      });
      job.retry(60, String(err?.message ?? err));
    }
  }
}

const CONSENT_EMAIL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function runConsentEmailSweeper() {
  console.log("[Worker] Consent-email sweeper started (5m interval)...");
  for (;;) {
    try {
      const stranded = await findStrandedConsentEmails();
      if (stranded.length > 0) {
        const db2 = honker.open(resolveQueueDbPath());
        const queue = db2.queue(CONSENT_EMAILS_QUEUE);
        for (const deliveryId of stranded)
          queue.enqueue({ deliveryId } satisfies ConsentEmailJobPayload);
        console.log(
          `[Worker] Re-enqueued ${stranded.length} stranded consent email(s)`,
        );
      }
      const exhausted = await failExhaustedConsentEmails();
      if (exhausted > 0) {
        console.log(
          `[Worker] Closed out ${exhausted} consent email(s) that ran out of attempts`,
        );
      }
    } catch (err: any) {
      console.error(
        "[Worker] Consent-email sweep failed:",
        err?.message ?? err,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, CONSENT_EMAIL_SWEEP_INTERVAL_MS),
    );
  }
}

/**
 * Bulk admin consent-PDF export jobs — always run here in the worker process,
 * never inline in a web request (see src/lib/consent-export.ts for why).
 */
async function consumeConsentExports() {
  console.log(
    `[Worker] Starting Honker queue consumer for '${CONSENT_EXPORTS_QUEUE}'...`,
  );
  for await (const job of consentExportsQueue.claim("consent-exports-worker")) {
    const { jobId } = job.payload as ConsentExportJobPayload;
    console.log(
      `[Worker] Picked up consent-export job ${job.id} for export ${jobId}`,
    );
    try {
      // runConsentExportJob records its own terminal COMPLETE/FAILED status
      // internally and always returns, so ack unconditionally.
      await runConsentExportJob(jobId);
    } catch (err: any) {
      console.error(
        `[Worker] Error on consent-export job ${job.id}:`,
        err?.message ?? err,
      );
      await logSystemEvent({
        category: "WORKER",
        type: "JOB_FAILED",
        severity: "ERROR",
        message: `Consent-export job failed: ${err?.message ?? err}`,
        metadata: {
          queue: CONSENT_EXPORTS_QUEUE,
          jobId: job.id,
          exportJobId: jobId,
        },
      });
    } finally {
      job.ack();
    }
  }
}

const CONSENT_EXPORT_GC_INTERVAL_MS = 60 * 60 * 1000;

/** Deletes expired bulk-export zips from S3 once their retention window passes. */
async function runConsentExportGcLoop() {
  console.log("[Worker] Consent-export GC loop started (1h interval)...");
  for (;;) {
    try {
      const cleaned = await sweepExpiredConsentExports();
      if (cleaned > 0)
        console.log(`[Worker] Cleaned up ${cleaned} expired consent export(s)`);
    } catch (err: any) {
      console.error(
        "[Worker] Consent-export GC run failed:",
        err?.message ?? err,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, CONSENT_EXPORT_GC_INTERVAL_MS),
    );
  }
}

async function consumeBackups() {
  console.log(
    `[Worker] Starting Honker queue consumer for '${BACKUPS_QUEUE}'...`,
  );
  for await (const job of backupsQueue.claim("backups-worker")) {
    const { includeS3 = false } = job.payload as BackupJobPayload;
    console.log(
      `[Worker] Picked up backup job ${job.id}${includeS3 ? " (database + S3)" : ""}`,
    );
    try {
      const result = await runBackupJob({ includeS3 });
      console.log(
        `[Worker] Backup complete: ${result.key} (pruned ${result.pruned.length}` +
          `${result.s3 ? `, copied ${result.s3.objectCount} S3 object(s)` : ""})`,
      );
    } catch (err: any) {
      console.error(
        `[Worker] Backup job ${job.id} failed:`,
        err?.message ?? err,
      );
      await logSystemEvent({
        category: "WORKER",
        type: "BACKUP_FAILED",
        severity: "ERROR",
        message: `Backup job failed: ${err?.message ?? err}`,
        metadata: { queue: BACKUPS_QUEUE, jobId: job.id },
      });
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
      console.error(
        "[Worker] Backup scheduler tick error:",
        err?.message ?? err,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

// GC cadence. The 24h object grace period in s3-gc.ts is what guarantees
// correctness; the interval only bounds how long orphans linger.
const S3_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const S3_GC_STARTUP_DELAY_MS = 60_000;

/**
 * S3 garbage collector loop: discards abandoned quiz-PDF extractions and
 * deletes bucket objects nothing in the database references anymore (deleted
 * quizzes/questions/users, superseded simulation versions, committed
 * extractions' PDFs and page rasters). The short startup delay keeps a
 * crash-looping worker from hammering full-bucket listings.
 */
async function runS3GcLoop() {
  await new Promise((resolve) => setTimeout(resolve, S3_GC_STARTUP_DELAY_MS));
  console.log("[Worker] S3 GC loop started (6h interval)...");
  for (;;) {
    try {
      const result = await runS3Gc();
      console.log(
        `[Worker] S3 GC done: ${result.staleExtractionsDiscarded} stale extraction(s) discarded, ` +
          `${result.orphanObjectsDeleted} orphaned object(s) deleted`,
      );
    } catch (err: any) {
      console.error("[Worker] S3 GC run failed:", err?.message ?? err);
      await logSystemEvent({
        category: "WORKER",
        type: "S3_GC_FAILED",
        severity: "ERROR",
        message: `S3 GC run failed: ${err?.message ?? err}`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, S3_GC_INTERVAL_MS));
  }
}

// How long SystemLog rows are kept before the daily prune below deletes them.
const SYSTEM_LOG_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.SYSTEM_LOG_RETENTION_DAYS) || 90,
);
const LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Daily retention prune for the admin system log: the instrumentation writes
 * rows from every login attempt and traffic sample, so without a cap the
 * table would grow without bound. Deleting by cutoff is idempotent — a missed
 * or repeated run just deletes nothing extra.
 */
async function runLogRetentionLoop() {
  console.log(
    `[Worker] System log retention loop started (24h interval, keep ${SYSTEM_LOG_RETENTION_DAYS} days)...`,
  );
  for (;;) {
    try {
      const cutoff = new Date(
        Date.now() - SYSTEM_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const { count } = await prisma.systemLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (count > 0) {
        console.log(
          `[Worker] Pruned ${count} system log row(s) older than ${cutoff.toISOString()}`,
        );
      }
    } catch (err: any) {
      console.error("[Worker] System log prune failed:", err?.message ?? err);
    }
    await new Promise((resolve) => setTimeout(resolve, LOG_PRUNE_INTERVAL_MS));
  }
}

const RESOURCE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Retention prune for the admin resource monitor. Every node writes a row a
 * minute, so this runs hourly rather than daily — a day's worth of expired
 * samples is thousands of rows to carry around for no reason.
 */
async function runResourceRetentionLoop() {
  console.log(
    `[Worker] Resource sample retention loop started (1h interval, keep ${RESOURCE_SAMPLE_RETENTION_DAYS} days)...`,
  );
  for (;;) {
    try {
      const count = await pruneResourceSamples();
      if (count > 0)
        console.log(`[Worker] Pruned ${count} expired resource sample(s)`);
    } catch (err: any) {
      console.error(
        "[Worker] Resource sample prune failed:",
        err?.message ?? err,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RESOURCE_PRUNE_INTERVAL_MS),
    );
  }
}

const ASSISTANT_ATTACHMENT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Retention sweep for chat-assistant attachments: deletes the S3 object and the
 * index row together once the audience's retention window has passed (see
 * AssistantConfig.attachmentRetentionDays, 30 days by default).
 *
 * Hourly rather than daily because each row can carry megabytes, and because the
 * sweep is batched — a backlog drains an hour at a time instead of a day.
 * Deleting by cutoff is idempotent, so a missed or repeated run is harmless.
 */
async function runAssistantAttachmentRetentionLoop() {
  console.log(
    "[Worker] Assistant attachment retention loop started (1h interval)...",
  );
  for (;;) {
    try {
      const count = await purgeExpiredAssistantAttachments();
      if (count > 0)
        console.log(`[Worker] Purged ${count} expired chat attachment(s)`);
    } catch (err: any) {
      console.error(
        "[Worker] Assistant attachment purge failed:",
        err?.message ?? err,
      );
      await logSystemEvent({
        category: "WORKER",
        type: "ASSISTANT_ATTACHMENT_PURGE_FAILED",
        severity: "ERROR",
        message: `Assistant attachment purge failed: ${err?.message ?? err}`,
      });
    }
    await new Promise((resolve) =>
      setTimeout(resolve, ASSISTANT_ATTACHMENT_PRUNE_INTERVAL_MS),
    );
  }
}

const ASSISTANT_TRANSCRIPT_ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Tiering sweep for chat transcripts: moves a conversation out of the hot
 * message rows and into one S3 object once it ages past its audience's history
 * window (AssistantConfig.historyRetentionDays, 30 days by default).
 *
 * Nothing is deleted — the point is to keep the SQLite file, and therefore every
 * nightly backup of it, bounded by retention rather than by total chat volume
 * while the transcripts themselves are kept for admins indefinitely. The one
 * exception is conversations that never recorded a turn (a model failure opened
 * the row and nothing was ever written to it), which are dropped instead.
 *
 * The cutoff is read per-audience every pass, so lowering the window in the
 * admin panel takes effect on the next sweep without a restart. Both halves are
 * idempotent, so a missed or repeated run is harmless.
 */
async function runAssistantTranscriptArchiveLoop() {
  console.log(
    "[Worker] Assistant transcript archive loop started (1h interval)...",
  );
  for (;;) {
    try {
      const cutoffs = await Promise.all(
        ASSISTANT_AUDIENCES.map(async (audience) => ({
          audience,
          cutoff: historyCutoff(
            (await getAssistantSettings(audience)).historyRetentionDays,
          ),
        })),
      );

      const dropped = await purgeEmptyConversations(cutoffs);
      if (dropped > 0)
        console.log(`[Worker] Dropped ${dropped} empty chat conversation(s)`);

      const archived = await archiveAgedConversations(cutoffs);
      if (archived > 0)
        console.log(`[Worker] Archived ${archived} chat transcript(s) to S3`);
    } catch (err: any) {
      console.error(
        "[Worker] Assistant transcript archive failed:",
        err?.message ?? err,
      );
      await logSystemEvent({
        category: "WORKER",
        type: "ASSISTANT_TRANSCRIPT_ARCHIVE_FAILED",
        severity: "ERROR",
        message: `Assistant transcript archive failed: ${err?.message ?? err}`,
      });
    }
    await new Promise((resolve) =>
      setTimeout(resolve, ASSISTANT_TRANSCRIPT_ARCHIVE_INTERVAL_MS),
    );
  }
}

async function startWorker() {
  try {
    // This node's own CPU/RAM/storage feed for the admin System Resources tab.
    // Started before the consumers so a worker that dies mid-job still leaves a
    // record of what it was doing to the box.
    startResourceSampler("worker");

    // Run all consumers + the scheduler concurrently; each blocks on its own loop.
    await Promise.all([
      consumeMaterials(),
      consumeExamResults(),
      consumeQuizExtractions(),
      consumeSimulations(),
      consumeMessageEmails(),
      runMessageEmailSweeper(),
      consumeConsentEmails(),
      runConsentEmailSweeper(),
      consumeConsentExports(),
      runConsentExportGcLoop(),
      consumeBackups(),
      runBackupScheduler(),
      runS3GcLoop(),
      runLogRetentionLoop(),
      runResourceRetentionLoop(),
      runAssistantAttachmentRetentionLoop(),
      runAssistantTranscriptArchiveLoop(),
    ]);
  } catch (err) {
    console.error("[Worker] Fatal error in worker loop:", err);
    await logSystemEvent({
      category: "WORKER",
      type: "WORKER_FATAL",
      severity: "ERROR",
      message: `Worker crashed: ${err instanceof Error ? err.message : err}`,
    });
    process.exit(1);
  }
}

startWorker();
