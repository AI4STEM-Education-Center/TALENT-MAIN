import honker from "@russellthehippo/honker-node";
import path from "path";

// Centralizes the Honker (SQLite-backed job queue) wiring shared by the API
// routes that enqueue jobs and the background worker that consumes them. The
// db-path resolution mirrors the existing inline logic in worker.ts and the
// materials `process` route so all producers/consumers open the same file.

export const EXAM_RESULTS_QUEUE = "exam-results";

export type ExamResultsJobPayload = { examResultId: string };

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
