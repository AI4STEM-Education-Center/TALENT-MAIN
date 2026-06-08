import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import honker from "@russellthehippo/honker-node";
import {
  resolveQueueDbPath,
  EXAM_RESULTS_QUEUE,
  type ExamResultsJobPayload,
} from "./queue";

describe("resolveQueueDbPath", () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it("maps the default dev sqlite url under prisma/", () => {
    process.env.DATABASE_URL = "file:./dev.db";
    expect(resolveQueueDbPath()).toBe(path.join(process.cwd(), "prisma", "dev.db"));
  });

  it("maps the prod sqlite url under prisma/data/", () => {
    process.env.DATABASE_URL = "file:./data/prod.db";
    expect(resolveQueueDbPath()).toBe(path.join(process.cwd(), "prisma", "data", "prod.db"));
  });

  it("resolves a relative file path against prisma/ and strips query params", () => {
    process.env.DATABASE_URL = "file:custom.db?connection_limit=1";
    expect(resolveQueueDbPath()).toBe(path.join(process.cwd(), "prisma", "custom.db"));
  });

  it("passes through an absolute file path unchanged", () => {
    const abs = path.resolve(os.tmpdir(), "abs.db");
    process.env.DATABASE_URL = `file:${abs}`;
    expect(resolveQueueDbPath()).toBe(abs);
  });
});

describe("Honker exam-results queue roundtrip", () => {
  // Uses a throwaway temp SQLite file — never the app database.
  const dbPath = path.join(os.tmpdir(), `honker-exam-test-${process.pid}-${Date.now()}.db`);
  let db: ReturnType<typeof honker.open> | null = null;

  afterEach(() => {
    db?.close();
    db = null;
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const f = `${dbPath}${suffix}`;
      if (existsSync(f)) rmSync(f);
    }
  });

  it("enqueues a job and claims it back with the exact payload, then drains", () => {
    db = honker.open(dbPath);
    const queue = db.queue(EXAM_RESULTS_QUEUE);

    const payload: ExamResultsJobPayload = { examResultId: "exam-result-123" };
    const jobId = queue.enqueue(payload);
    expect(typeof jobId).toBe("number");

    const job = queue.claimOne("test-worker");
    expect(job).not.toBeNull();
    expect(job!.queue).toBe(EXAM_RESULTS_QUEUE);
    expect((job!.payload as ExamResultsJobPayload).examResultId).toBe("exam-result-123");

    expect(job!.ack()).toBe(true);

    // Nothing left to claim once acked.
    expect(queue.claimOne("test-worker")).toBeNull();
  });

  it("delivers jobs in FIFO order across multiple enqueues", () => {
    db = honker.open(dbPath);
    const queue = db.queue(EXAM_RESULTS_QUEUE);

    queue.enqueue({ examResultId: "a" } satisfies ExamResultsJobPayload);
    queue.enqueue({ examResultId: "b" } satisfies ExamResultsJobPayload);

    const first = queue.claimOne("test-worker");
    const second = queue.claimOne("test-worker");
    first?.ack();
    second?.ack();

    expect((first!.payload as ExamResultsJobPayload).examResultId).toBe("a");
    expect((second!.payload as ExamResultsJobPayload).examResultId).toBe("b");
  });
});
