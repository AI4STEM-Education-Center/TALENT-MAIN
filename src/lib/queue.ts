import honker from "@russellthehippo/honker-node";
import { resolveDatabaseUrl } from "./db-url";

// Centralizes the Honker (SQLite-backed job queue) wiring shared by the API
// routes that enqueue jobs and the background worker that consumes them. All
// producers/consumers resolve the queue file the same way so they open the
// same database.

export const EXAM_RESULTS_QUEUE = "exam-results";
export const QUIZ_EXTRACTIONS_QUEUE = "quiz-extractions";
export const BACKUPS_QUEUE = "backups";

export type ExamResultsJobPayload = { examResultId: string };
export type QuizExtractionJobPayload = { extractionId: string };
export type BackupJobPayload = { action: "backup" };

/**
 * Map a main SQLite path to Honker's sibling queue path (`foo.db` ->
 * `foo.queue.db`). Pure helper, split out so the derivation is easy to unit test.
 */
export function deriveQueueDbPath(mainDbPath: string): string {
  if (mainDbPath === ":memory:" || mainDbPath === "file::memory:") {
    return mainDbPath;
  }
  return mainDbPath.endsWith(".db")
    ? `${mainDbPath.slice(0, -".db".length)}.queue.db`
    : `${mainDbPath}.queue.db`;
}

/**
 * Absolute path to the DEDICATED SQLite file Honker opens for its queue tables.
 *
 * Honker creates its own `_honker_*` tables in whatever file it opens. That used
 * to be the same file Prisma manages, which made `prisma db push` want to DROP
 * those unknown tables — a destructive diff that (in production, where
 * `--accept-data-loss` is withheld) makes the whole push refuse, so legitimate
 * additive schema changes never apply. We give Honker a sibling `<name>.queue.db`
 * so the app schema and the queue never share a file: Prisma never sees the
 * `_honker_*` tables, and the queue is structurally immune to schema-push data
 * loss. Resolution reuses resolveDatabaseUrl so the queue file always sits
 * beside the exact file Prisma opens.
 */
export function resolveQueueDbPath(): string {
  const url = resolveDatabaseUrl();
  const mainPath = url.startsWith("file:") ? url.slice("file:".length) : url;
  return deriveQueueDbPath(mainPath);
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
