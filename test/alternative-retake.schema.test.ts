import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

it("pushes retake columns onto a populated legacy schema without destructive flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "alt-retake-upgrade-"));
  const dbPath = join(dir, "upgrade.db");
  const schemaPath = join(dir, "legacy.prisma");
  const current = readFileSync("prisma/schema.prisma", "utf8");
  // Model the deployed schema before retake recording, retaining all unrelated
  // current models so this exercises the real Prisma schema engine upgrade.
  const removed: Record<string, string[]> = {
    QuizAttempt: [
      "practiceVersionId",
      "practiceVersionName",
      "excludedQuestionIds",
    ],
    ExamResult: ["practiceVersionName", "excludedCount"],
    QuizPracticeAttempt: ["quizAttemptId"],
  };
  const legacy = current.replace(
    /model (\w+) \{[\s\S]*?\n\}/g,
    (block, name: string) => {
      const fields = removed[name];
      if (!fields) return block;
      return block
        .split("\n")
        .filter(
          (line) =>
            !fields.some((field) =>
              new RegExp(
                `^\\s*${field}\\s|^\\s*@@(?:index|unique)\\(\\[${field}\\]`,
              ).test(line),
            ),
        )
        .join("\n");
    },
  );
  writeFileSync(schemaPath, legacy);
  const push = (schema: string) =>
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/prisma/build/index.js"),
        "db",
        "push",
        "--schema",
        schema,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: `file:${dbPath}`,
          RUST_LOG: "trace",
        },
        // Noninteractive deploy must succeed without --accept-data-loss.
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      },
    );
  try {
    push(schemaPath);
    const before = new Database(dbPath);
    try {
      before.pragma("foreign_keys = OFF");
      before
        .prepare(
          "INSERT INTO QuizPracticeAttempt (id, studentId, classId, quizId, versionId, versionName, questions) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "legacy",
          "student",
          "class",
          "quiz",
          "version",
          "Version A",
          "[]",
        );
      before
        .prepare(
          "INSERT INTO QuizAttempt (id, studentId, classId, subtopicId) VALUES (?, ?, ?, ?)",
        )
        .run("ordinary", "student", "class", "quiz");
      before
        .prepare(
          "INSERT INTO ExamResult (id, quizAttemptId, studentId, classId, subtopicId, className, topicName, subtopicName, score, correctCount, totalCount, completedAt, reviewSnapshot, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "result",
          "ordinary",
          "student",
          "class",
          "quiz",
          "Class",
          "Topic",
          "Quiz",
          50,
          1,
          2,
          Date.now(),
          '{"questions":[]}',
          Date.now(),
        );
    } finally {
      before.close();
    }
    push(resolve("prisma/schema.prisma"));
    const after = new Database(dbPath);
    try {
      expect(
        after
          .prepare(
            "SELECT quizAttemptId, versionName FROM QuizPracticeAttempt WHERE id = ?",
          )
          .get("legacy"),
      ).toEqual({ quizAttemptId: null, versionName: "Version A" });
      expect(
        after
          .prepare(
            "SELECT practiceVersionId, practiceVersionName, excludedQuestionIds FROM QuizAttempt WHERE id = ?",
          )
          .get("ordinary"),
      ).toEqual({
        practiceVersionId: null,
        practiceVersionName: null,
        excludedQuestionIds: "[]",
      });
      expect(
        after
          .prepare(
            "SELECT score, practiceVersionName, excludedCount FROM ExamResult WHERE id = ?",
          )
          .get("result"),
      ).toEqual({ score: 50, practiceVersionName: null, excludedCount: 0 });
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
