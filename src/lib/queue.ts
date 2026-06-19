import honker from "@russellthehippo/honker-node";
import path from "path";

// Centralizes the Honker (SQLite-backed job queue) wiring shared by the API
// routes that enqueue jobs and the background worker that consumes them. The
// db-path resolution mirrors the existing inline logic in worker.ts and the
// materials `process` route so all producers/consumers open the same file.

export const EXAM_RESULTS_QUEUE = "exam-results";
export const QUIZ_EXTRACTIONS_QUEUE = "quiz-extractions";
export const BACKUPS_QUEUE = "backups";

export type ExamResultsJobPayload = { examResultId: string };
export type QuizExtractionJobPayload = { extractionId: string };
export type BackupJobPayload = { action: "backup" };

/**
 * Resolve the absolute SQLite path Honker should open from DATABASE_URL,
 * matching Prisma's relative `file:` resolution (relative to the prisma dir).
 */
export function resolveQueueDbPath(): string {
  const dbUrl = process.env.DATABASE_URL || "file:./dev.db";
  let dbPath = dbUrl.replace("file:", "").split("?")[0];
  if (dbPath === "./dev.db") {
    dbPath = path.join(process.cwd(), "prisma", "dev.db");
  } else if (dbPath === "./data/prod.db") {
    dbPath = path.join(process.cwd(), "prisma", "data", "prod.db");
  } else if (!path.isAbsolute(dbPath)) {
    dbPath = path.join(process.cwd(), "prisma", dbPath);
  }
  return dbPath;
}

/**
 * Enqueue a background job to generate the AI summary + recommendations for an
 * ExamResult. Best-effort: enqueue failures are swallowed by the caller so a
 * quiz submission never fails because the queue is unavailable.
 */
export function enqueueExamResult(examResultId: string): void {
  const db = honker.open(resolveQueueDbPath());
  const payload: ExamResultsJobPayload = { examResultId };
  db.queue(EXAM_RESULTS_QUEUE).enqueue(payload);
}

/**
 * Enqueue a background job to run vision-LLM extraction for an uploaded quiz
 * PDF. Unlike enqueueExamResult, callers must NOT swallow failures: the job is
 * the feature, so the complete route marks the extraction FAILED if this throws.
 */
export function enqueueQuizExtraction(extractionId: string): void {
  const db = honker.open(resolveQueueDbPath());
  const payload: QuizExtractionJobPayload = { extractionId };
  db.queue(QUIZ_EXTRACTIONS_QUEUE).enqueue(payload);
}

/**
 * Enqueue a database-backup job. Used by the admin "Backup now" button and by
 * the worker's scheduler tick. The worker performs the snapshot + WebDAV upload
 * off the request path so the live site is never blocked.
 */
export function enqueueBackup(): void {
  const db = honker.open(resolveQueueDbPath());
  const payload: BackupJobPayload = { action: "backup" };
  db.queue(BACKUPS_QUEUE).enqueue(payload);
}
