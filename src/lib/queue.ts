import honker from "@russellthehippo/honker-node";
import { resolveDatabaseUrl } from "./db-url";

// Centralizes the Honker (SQLite-backed job queue) wiring shared by the API
// routes that enqueue jobs and the background worker that consumes them. All
// producers/consumers resolve the queue file the same way so they open the
// same database.

export const EXAM_RESULTS_QUEUE = "exam-results";
export const QUIZ_EXTRACTIONS_QUEUE = "quiz-extractions";
export const BACKUPS_QUEUE = "backups";
export const SIMULATIONS_QUEUE = "simulations";
export const MESSAGE_EMAILS_QUEUE = "message-emails";
export const CONSENT_EMAILS_QUEUE = "consent-emails";
export const CONSENT_EXPORTS_QUEUE = "consent-exports";

export type ExamResultsJobPayload = { examResultId: string };
export type QuizExtractionJobPayload = { extractionId: string };
export type BackupJobPayload = { action: "backup"; includeS3?: boolean };
// feedbackId present = a revision of an existing artifact; absent = first generation.
export type SimulationJobPayload = {
  simulationId: string;
  feedbackId?: string;
};
// One job per recipient (a MessageEmailDelivery row), so one bad address never
// holds up the rest of a class broadcast and each recipient retries on its own.
export type MessageEmailJobPayload = { deliveryId: string };
// One job per recipient (a ConsentEmailDelivery row) — see src/lib/consent-email.ts.
export type ConsentEmailJobPayload = { deliveryId: string };
// One job per bulk admin PDF export (a ConsentExportJob row) — always run in
// the worker, never inline in a web request; see src/lib/consent-export.ts.
export type ConsentExportJobPayload = { jobId: string };

/**
 * Queue options for MESSAGE_EMAILS_QUEUE, shared by the producer and the worker
 * so both agree on the visibility timeout. Attempt capping lives in the
 * database (MessageEmailDelivery.attempts) rather than Honker's maxAttempts:
 * the sweeper can re-enqueue a stranded row as a brand-new job, and only the
 * persisted counter survives that.
 */
export const MESSAGE_EMAILS_QUEUE_OPTIONS = {
  visibilityTimeoutS: 120,
} as const;

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
 * Enqueue a background job to generate (or, with a feedbackId, revise) one
 * question's simulation. Like enqueueQuizExtraction, callers must NOT swallow
 * failures: the job is the feature, so trigger routes mark the simulation row
 * FAILED if this throws.
 */
export function enqueueSimulation(
  simulationId: string,
  feedbackId?: string,
): void {
  const db = honker.open(resolveQueueDbPath());
  const payload: SimulationJobPayload = feedbackId
    ? { simulationId, feedbackId }
    : { simulationId };
  db.queue(SIMULATIONS_QUEUE).enqueue(payload);
}

/**
 * Enqueue delivery jobs for a message's recipients — one job each, so a single
 * unreachable address can't hold up the rest of the class. The queue file is
 * opened once for the whole batch.
 *
 * Callers log failures rather than propagating them: the MessageEmailDelivery
 * rows are already PENDING in the database, so a failed enqueue delays delivery
 * until the worker's sweeper picks them up instead of losing the emails.
 */
export function enqueueMessageEmails(deliveryIds: string[]): void {
  if (deliveryIds.length === 0) return;
  const db = honker.open(resolveQueueDbPath());
  const queue = db.queue(MESSAGE_EMAILS_QUEUE, MESSAGE_EMAILS_QUEUE_OPTIONS);
  for (const deliveryId of deliveryIds) {
    queue.enqueue({ deliveryId } satisfies MessageEmailJobPayload);
  }
}

/**
 * Enqueue a backup job. Scheduled calls retain the database-only default; the
 * admin's explicit manual action opts into the potentially large S3 snapshot.
 */
export function enqueueBackup(options: { includeS3?: boolean } = {}): void {
  const db = honker.open(resolveQueueDbPath());
  const payload: BackupJobPayload = {
    action: "backup",
    includeS3: options.includeS3 === true,
  };
  db.queue(BACKUPS_QUEUE).enqueue(payload);
}

/**
 * Enqueue delivery jobs for consent-related emails (confirmation copy, export
 * request/ready notices) — one job per ConsentEmailDelivery row, mirroring
 * enqueueMessageEmails. Callers log failures rather than propagating them: the
 * delivery rows are already PENDING in the database, so a failed enqueue just
 * delays delivery until the worker's sweeper picks it up.
 */
export function enqueueConsentEmails(deliveryIds: string[]): void {
  if (deliveryIds.length === 0) return;
  const db = honker.open(resolveQueueDbPath());
  const queue = db.queue(CONSENT_EMAILS_QUEUE);
  for (const deliveryId of deliveryIds) {
    queue.enqueue({ deliveryId } satisfies ConsentEmailJobPayload);
  }
}

/**
 * Enqueue a bulk admin consent-PDF export job. The job itself (a
 * ConsentExportJob row) is already PENDING in the database; this only wakes
 * the worker to pick it up. Callers should not swallow failures — a lost
 * enqueue leaves the admin's request sitting at PENDING with nothing driving
 * it forward, so the export route surfaces the error rather than pretending
 * the job was queued.
 */
export function enqueueConsentExport(jobId: string): void {
  const db = honker.open(resolveQueueDbPath());
  const payload: ConsentExportJobPayload = { jobId };
  db.queue(CONSENT_EXPORTS_QUEUE).enqueue(payload);
}
