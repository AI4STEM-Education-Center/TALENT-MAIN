/**
 * Deterministic synthetic dataset for tier 1 (local) runs.
 *
 * DETERMINISM IS THE POINT. A regression comparison is only valid if the only
 * difference between two runs is the code, so every id, name, score and
 * relationship here is derived from a counter — never from Math.random(),
 * Date.now() or cuid(). Two seeds of the same scale factor produce a
 * byte-identical database, which is also what lets tier 3 ship one golden file
 * instead of reseeding on every clone.
 *
 * MEDIA IS NOT OPTIONAL. The signing cost that commit af6fe35 introduced is
 * invisible in a dataset whose questions have no figures and no image answer
 * choices: attachFigureUrls / attachOptionImageUrls simply return null for every
 * row and POST /api/quiz does zero signatures. So this seed deliberately builds
 * one media-heavy quiz per class, and records it in the manifest so
 * k6/scenarios/media-signing.js can target it. The storage keys point at objects
 * that need not exist — presigning and CloudFront signing are pure local
 * operations that never contact S3, which is exactly the cost being measured.
 *
 * SAFETY. Refuses any target whose filename does not contain "bench". The whole
 * script is destructive by design (it truncates the tables it owns), and pointing
 * it at prod.db or dev.db by accident is a data-loss event, not an inconvenience.
 *
 * Usage:
 *   tsx benchmark/seed/seed-bench.ts --database-url file:./benchmark/.tmp/bench.db --scale 1
 */

import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, str, num } from "../tools/args";

/** Known password for every synthetic account, used by login-storm. */
export const BENCH_PASSWORD = "BenchPassw0rd!";
/** Username prefix that marks an account as synthetic and safe to hand out. */
export const BENCH_PREFIX = "bench_";
/**
 * Pinned bcrypt salt (cost 12, matching the app). Fixed so the seeded User rows
 * are byte-identical between runs — see the note at its use site. Only ever
 * applied to synthetic bench accounts.
 */
const BENCH_SALT = "$2b$12$benchmarkfixedsalt22ch";

/**
 * Counter-derived ids with cuid-like width.
 *
 * Width matters more than it looks: SQLite stores TEXT ids inline and every
 * index entry carries them, so a dataset built from 8-character ids has
 * measurably smaller B-trees and better cache behaviour than the real 25-char
 * cuids. Matching the width keeps the synthetic dataset's page counts
 * representative instead of flatteringly small.
 */
function id(kind: string, n: number): string {
  const body = `${kind}${String(n).padStart(10, "0")}`;
  return `c${body.padEnd(24, "z")}`.slice(0, 25);
}

/** Deterministic pseudo-random in [0,1) — a hash, not a PRNG with hidden state. */
function det(...parts: (string | number)[]): number {
  let h = 2166136261;
  const input = parts.join(":");
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Fixed epoch so `createdAt` values are identical across runs. */
const EPOCH = new Date("2026-01-01T00:00:00.000Z").getTime();
function at(offsetMinutes: number): Date {
  return new Date(EPOCH + offsetMinutes * 60_000);
}

async function main() {
  const args = parseArgs();
  const databaseUrl = str(args, "database-url", process.env.DATABASE_URL ?? "");
  if (!databaseUrl) throw new Error("--database-url is required");

  const filePath = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;
  const basename = path.basename(filePath);
  // The guard. Not a warning, not a prompt — a refusal.
  if (!basename.includes("bench")) {
    throw new Error(
      `refusing to seed "${basename}": this script TRUNCATES the tables it owns, and the target ` +
        `filename must contain "bench" to prove it is a throwaway database. ` +
        `prod.db / dev.db are never valid targets.`
    );
  }

  const scale = num(args, "scale", 1);
  // Shape chosen to resemble the real deployment's proportions rather than to be
  // round numbers: ~30 students per class, a handful of quizzes per class, and
  // one media-heavy quiz per class.
  const teacherCount = Math.max(1, Math.round(12 * scale));
  const classesPerTeacher = 2;
  const studentsPerClass = Math.max(1, Math.round(30 * scale));
  const quizzesPerClass = 4;
  const questionsPerQuiz = 10;
  const optionsPerQuestion = 4;
  /** How many of the questions in the media-heavy quiz carry a figure + image options. */
  const mediaQuestionCount = questionsPerQuiz;

  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl, timeout: 5000 });
  const prisma = new PrismaClient({ adapter });

  console.log(`seeding ${basename} (scale ${scale})`);

  // Truncate in FK-safe order. `deleteMany` rather than dropping tables so the
  // schema `db push` created stays intact.
  for (const step of [
    () => prisma.quizAnswer.deleteMany(),
    () => prisma.examResult.deleteMany(),
    () => prisma.quizAttempt.deleteMany(),
    () => prisma.quizProgress.deleteMany(),
    () => prisma.classQuiz.deleteMany(),
    () => prisma.option.deleteMany(),
    () => prisma.question.deleteMany(),
    () => prisma.quiz.deleteMany(),
    () => prisma.topic.deleteMany(),
    () => prisma.classEnrollment.deleteMany(),
    () => prisma.class.deleteMany(),
    () => prisma.student.deleteMany(),
    () => prisma.teacher.deleteMany(),
    () => prisma.user.deleteMany(),
  ]) {
    await step();
  }

  // One bcrypt hash, reused for every account, computed against a FIXED salt.
  //
  // Two separate reasons, both load-bearing:
  //  - Hashing N accounts individually at cost 12 would take minutes and produce
  //    N identical-strength hashes for no benefit; the harness needs one known
  //    password, not distinct ones.
  //  - bcrypt.hash() generates a RANDOM salt, so the User table differed on every
  //    seed and no two seeds compared equal. A pinned salt is what makes the
  //    dataset reproducible. It is safe precisely because these are throwaway
  //    synthetic accounts in a database whose filename must contain "bench" —
  //    never a real credential. Cost stays 12 so the login-storm scenario
  //    measures the same work the real app does.
  const hashedPassword = bcrypt.hashSync(BENCH_PASSWORD, BENCH_SALT);

  const topicId = id("top", 1);
  await prisma.topic.create({
    data: { id: topicId, name: "Benchmark Mechanics", contentType: "QUIZ", order: 0, createdAt: at(0) },
  });

  const manifest: {
    scale: number;
    counts: Record<string, number>;
    mediaTargets: Array<{ classId: string; quizId: string; signaturesPerStart: number }>;
    credentials: { prefix: string; password: string };
  } = {
    scale,
    counts: {},
    mediaTargets: [],
    credentials: { prefix: BENCH_PREFIX, password: BENCH_PASSWORD },
  };

  let userSeq = 0;
  let quizSeq = 0;
  let questionSeq = 0;
  let optionSeq = 0;
  let totalStudents = 0;
  let totalQuestions = 0;
  let totalOptions = 0;
  let totalAttempts = 0;
  let totalAnswers = 0;

  // ─── Admin ─────────────────────────────────────────────────────────────────
  await prisma.user.create({
    data: {
      id: id("usr", ++userSeq),
      email: `${BENCH_PREFIX}admin@bench.invalid`,
      username: `${BENCH_PREFIX}admin`,
      hashedPassword,
      firstName: "Bench",
      lastName: "Admin",
      role: "ADMIN",
      createdAt: at(1),
    },
  });

  for (let t = 1; t <= teacherCount; t++) {
    const teacherUserId = id("usr", ++userSeq);
    const teacherId = id("tch", t);

    await prisma.user.create({
      data: {
        id: teacherUserId,
        email: `${BENCH_PREFIX}teacher${t}@bench.invalid`,
        username: `${BENCH_PREFIX}teacher${t}`,
        hashedPassword,
        firstName: "Teacher",
        lastName: `Number${t}`,
        role: "TEACHER",
        createdAt: at(10 + t),
        teacher: { create: { id: teacherId } },
      },
    });

    for (let c = 1; c <= classesPerTeacher; c++) {
      const classId = id("cls", (t - 1) * classesPerTeacher + c);
      await prisma.class.create({
        data: {
          id: classId,
          name: `Bench Class ${t}-${c}`,
          teacherId,
          createdAt: at(100 + t * 10 + c),
        },
      });

      // ── Students, enrolled in this class ──
      const studentIds: string[] = [];
      for (let s = 1; s <= studentsPerClass; s++) {
        const studentUserId = id("usr", ++userSeq);
        const studentId = id("stu", ++totalStudents);
        studentIds.push(studentId);
        await prisma.user.create({
          data: {
            id: studentUserId,
            email: `${BENCH_PREFIX}student${totalStudents}@bench.invalid`,
            username: `${BENCH_PREFIX}student${totalStudents}`,
            hashedPassword,
            firstName: "Student",
            lastName: `Number${totalStudents}`,
            role: "STUDENT",
            createdAt: at(1000 + totalStudents),
            student: { create: { id: studentId } },
          },
        });
        await prisma.classEnrollment.create({
          // Explicit id: @default(cuid()) would mint a RANDOM id per run, which
          // silently breaks the determinism this whole file exists to provide.
          data: {
            id: id("enr", totalStudents),
            classId,
            studentId,
            joinedAt: at(2000 + totalStudents),
          },
        });
      }

      // ── Quizzes ──
      for (let q = 1; q <= quizzesPerClass; q++) {
        const quizId = id("qiz", ++quizSeq);
        // The LAST quiz in each class is the media-heavy one.
        const isMediaQuiz = q === quizzesPerClass;

        await prisma.quiz.create({
          data: {
            id: quizId,
            name: isMediaQuiz ? `Bench Quiz ${t}-${c}-${q} (media)` : `Bench Quiz ${t}-${c}-${q}`,
            topicId,
            teacherId,
            order: q,
            createdAt: at(3000 + quizSeq),
          },
        });

        for (let n = 1; n <= questionsPerQuiz; n++) {
          const questionId = id("qst", ++questionSeq);
          totalQuestions++;
          const withMedia = isMediaQuiz && n <= mediaQuestionCount;

          // Mode mix: mostly single-select, some multi, some numeric — so
          // scoreQuiz's three branches are all exercised under load.
          const modeRoll = det("mode", questionId);
          const answerMode =
            modeRoll < 0.7 ? "SINGLE_SELECT" : modeRoll < 0.9 ? "MULTI_SELECT" : "NUMERIC";

          await prisma.question.create({
            data: {
              id: questionId,
              quizId,
              text: `Question ${n} of bench quiz ${quizSeq}. What is the expected result?`,
              answerMode,
              answerNumeric: answerMode === "NUMERIC" ? Math.round(det("num", questionId) * 100) / 2 : null,
              answerTolerance: answerMode === "NUMERIC" ? 0.5 : null,
              answerUnit: answerMode === "NUMERIC" ? "m/s" : null,
              points: 1,
              // A figure key that need not exist in S3: signObjectReadUrl signs
              // a URL without contacting the bucket, so the signing cost is real
              // even though the object is not. quiz_media fetches will 403/404,
              // which the taxonomy records rather than hiding.
              figureStorageKey: withMedia ? `bench/figures/${questionId}.png` : null,
              figureAlt: withMedia ? `Figure for question ${n}` : null,
              createdAt: at(4000 + questionSeq),
            },
          });

          if (answerMode !== "NUMERIC") {
            const correctIndex = Math.floor(det("correct", questionId) * optionsPerQuestion);
            for (let o = 0; o < optionsPerQuestion; o++) {
              totalOptions++;
              await prisma.option.create({
                data: {
                  id: id("opt", ++optionSeq),
                  questionId,
                  text: `Option ${String.fromCharCode(65 + o)}`,
                  isCorrect:
                    answerMode === "MULTI_SELECT"
                      ? o === correctIndex || o === (correctIndex + 1) % optionsPerQuestion
                      : o === correctIndex,
                  // IMAGE ANSWER CHOICES are the multiplier that makes signing
                  // cost dominate: each one is its own signature, so a
                  // 10-question quiz with 4 image options each is 10 + 40 = 50
                  // RSA operations for a single quiz start.
                  imageStorageKey: withMedia ? `bench/options/${id("opt", optionSeq)}.png` : null,
                  imageAlt: withMedia ? `Choice ${String.fromCharCode(65 + o)}` : null,
                },
              });
            }
          }
        }

        await prisma.classQuiz.create({
          data: {
            id: id("cqz", quizSeq),
            classId,
            quizId,
            published: true,
            // High enough that a long soak does not exhaust the cap and turn
            // every subsequent start into a designed 403 (which would silently
            // stop measuring the write path).
            maxAttempts: 50,
          },
        });

        if (isMediaQuiz) {
          const signaturesPerStart = mediaQuestionCount * (1 + optionsPerQuestion);
          manifest.mediaTargets.push({ classId, quizId, signaturesPerStart });
        }

        // ── Historical attempts ──
        // Gives teacher_quiz_stats real rows to aggregate and the dashboard real
        // history to render. Without these, stats endpoints return trivially fast
        // and the run reports a latency that no real deployment ever sees.
        const historicalStudents = studentIds.slice(0, Math.ceil(studentIds.length * 0.6));
        // Read the question set ONCE per quiz. Fetching it per attempt made this
        // O(quizzes x students) round trips against a synchronous binding, which
        // dominated the whole seed.
        const quizQuestions = await prisma.question.findMany({
          where: { quizId },
          select: { id: true, answerMode: true, options: { select: { id: true, isCorrect: true } } },
          orderBy: { id: "asc" },
        });
        for (const studentId of historicalStudents) {
          const attemptId = id("att", ++totalAttempts);
          const score = Math.round(det("score", attemptId) * 100);
          await prisma.quizAttempt.create({
            data: {
              id: attemptId,
              studentId,
              classId,
              quizId,
              score,
              startedAt: at(6000 + totalAttempts),
              completedAt: at(6001 + totalAttempts),
            },
          });
          await prisma.quizProgress.create({
            data: {
              id: id("prg", totalAttempts),
              studentId,
              classId,
              quizId,
              status: "COMPLETED",
              bestScore: score,
            },
          });

          // createMany in one call rather than one insert per answer: each
          // await is a separate write transaction on the single write lock, so
          // batching here is the difference between one lock acquisition and
          // `questionsPerQuiz` of them per attempt.
          const answerRows = quizQuestions.map((question) => {
            const correct = det("ans", attemptId, question.id) < score / 100;
            const chosen =
              question.options.find((o) => o.isCorrect === correct) ?? question.options[0];
            totalAnswers++;
            return {
              id: id("ans", totalAnswers),
              quizAttemptId: attemptId,
              questionId: question.id,
              selectedOptionId:
                question.answerMode === "MULTI_SELECT" || question.answerMode === "NUMERIC"
                  ? null
                  : chosen?.id ?? null,
              selectedOptionIds: JSON.stringify(chosen && question.answerMode !== "NUMERIC" ? [chosen.id] : []),
              numericValue: question.answerMode === "NUMERIC" ? Math.round(det("nv", attemptId, question.id) * 100) / 2 : null,
              isCorrect: correct,
            };
          });
          await prisma.quizAnswer.createMany({ data: answerRows });
        }
      }
    }
  }

  // Prisma sets every `@updatedAt` column to the wall clock on insert and
  // ignores an explicit value, so Topic/Quiz/Question rows carry a different
  // timestamp on every seed. That alone makes two seeds of identical data
  // compare as different, which would defeat both the regression baseline and
  // the shipped golden database. One raw UPDATE pins them to the fixed epoch.
  //
  // Raw SQL because there is no Prisma-level way to write an @updatedAt column.
  // Table names are the @@map values, not the model names (Quiz -> "Subtopic",
  // QuizProgress -> "ModuleProgress").
  const FIXED_UPDATED_AT = at(0).toISOString();
  for (const table of ["Topic", "Subtopic", "Question", "ModuleProgress"]) {
    await prisma.$executeRawUnsafe(`UPDATE "${table}" SET "updatedAt" = ?`, FIXED_UPDATED_AT);
  }

  manifest.counts = {
    teachers: teacherCount,
    classes: teacherCount * classesPerTeacher,
    students: totalStudents,
    quizzes: quizSeq,
    questions: totalQuestions,
    options: totalOptions,
    attempts: totalAttempts,
    answers: totalAnswers,
  };

  const manifestPath = path.join(path.dirname(path.resolve(filePath)), "seed-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify(manifest.counts, null, 2));
  console.log(`media targets: ${manifest.mediaTargets.length} (${manifest.mediaTargets[0]?.signaturesPerStart ?? 0} signatures per quiz start)`);
  console.log(`manifest -> ${manifestPath}`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(`seed-bench failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
