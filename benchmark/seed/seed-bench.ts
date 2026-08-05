/**
 * Deterministic, scale-factored benchmark dataset.
 *
 * A load test against a freshly seeded database measures almost nothing: the
 * endpoints that decay with volume are the aggregation ones
 * (src/lib/quiz-stats-server.ts, grades-export, admin stats), and SQLite's page
 * layout / index depth only become realistic once there is history in the
 * tables. So this builds a full term's worth of data at a configurable scale
 * and writes a manifest the rest of the harness reads.
 *
 * Determinism matters twice over. The RNG is seeded (so run N and run N+1 are
 * comparing the same dataset), and row ids are derived from counters rather
 * than cuid() — reruns produce byte-identical ids, which is what lets
 * benchmark/seed/snapshot.sh treat the resulting .db as a reusable golden
 * image. Ids keep cuid's 25-character length because id width changes b-tree
 * fan-out, and we want the index shape the app really has.
 *
 * SAFETY: refuses to run unless the target database filename looks like a
 * benchmark database. This script bulk-writes and is meant to be pointed at a
 * throwaway file; the guard is what stops a stray DATABASE_URL from aiming it
 * at prod.db.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDatabaseUrl } from "../../src/lib/db-url";
import { buildReviewSnapshot } from "../../src/lib/exam-results";

// ─── Scale factors ────────────────────────────────────────────────────────────
// Defaults describe a mid-size deployment: 3 teachers, 12 classes, 360
// students, 20 quizzes of 25 questions, and ~40 historical attempts per
// student (~14k attempts / ~360k answers). Override any of them by env var;
// `BENCH_SCALE` multiplies the class/student/history counts for quick "half
// size" or "double size" runs.

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
};

const SCALE = num("BENCH_SCALE", 1);
const scaled = (name: string, fallback: number) =>
  Math.max(1, Math.round(num(name, fallback) * SCALE));

const CONFIG = {
  seed: num("BENCH_SEED", 20260805),
  teachers: scaled("BENCH_TEACHERS", 3),
  classesPerTeacher: scaled("BENCH_CLASSES_PER_TEACHER", 4),
  studentsPerClass: scaled("BENCH_STUDENTS_PER_CLASS", 30),
  quizzes: scaled("BENCH_QUIZZES", 20),
  questionsPerQuiz: Math.max(1, num("BENCH_QUESTIONS_PER_QUIZ", 25)),
  optionsPerQuestion: Math.max(2, num("BENCH_OPTIONS_PER_QUESTION", 4)),
  /** Completed attempts of past quizzes, per student. Drives QuizAnswer volume. */
  historyAttemptsPerStudent: scaled("BENCH_HISTORY_ATTEMPTS_PER_STUDENT", 40),
  /** Fraction of historical attempts that also carry an ExamResult snapshot. */
  examResultRatio: num("BENCH_EXAM_RESULT_RATIO", 0.6),
  /**
   * Quizzes per class reserved for the live load test to drive.
   *
   * Clamped to leave at least one quiz for history — otherwise a small
   * BENCH_SCALE (fewer quizzes than this) would mark every quiz live, and the
   * load test's own attempts would land in the same quizzes the seeded history
   * occupies. The two must stay disjoint: history exists so aggregation
   * endpoints have volume to chew on, live quizzes exist so a soak can submit
   * thousands of attempts without hitting an attempt cap.
   */
  liveQuizzesPerClass: Math.min(
    Math.max(1, num("BENCH_LIVE_QUIZZES_PER_CLASS", 3)),
    Math.max(1, scaled("BENCH_QUIZZES", 20) - 1)
  ),
  /** Questions carrying a figure key, so presigning work is exercised. */
  figureRatio: num("BENCH_FIGURE_RATIO", 0.2),
  // Must be an address the *app container* can resolve, not the host's
  // loopback — the compose service name works for both the local stack and the
  // EC2 clone, and it is baked into the shipped database.
  mockAiBaseUrl: process.env.BENCH_MOCK_AI_URL || "http://bench-mock-ai:8088/v1",
  bcryptCost: Math.max(4, num("BENCH_BCRYPT_COST", 12)),
};

const OUT_DIR = process.env.BENCH_MANIFEST_DIR
  ? path.resolve(process.env.BENCH_MANIFEST_DIR)
  : path.resolve(__dirname, "..", "results");

// ─── Deterministic helpers ────────────────────────────────────────────────────

/** mulberry32 — small, fast, and reproducible across Node versions. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(CONFIG.seed);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];
const intBetween = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

/**
 * Deterministic 25-character id, matching cuid's width so index pages have a
 * realistic fan-out. `kind` keeps namespaces from colliding and makes a row's
 * origin readable in query plans and logs.
 */
const idCounters = new Map<string, number>();
function bid(kind: string): string {
  const n = (idCounters.get(kind) ?? 0) + 1;
  idCounters.set(kind, n);
  const digest = crypto
    .createHash("sha256")
    .update(`${CONFIG.seed}:${kind}:${n}`)
    .digest("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return `c${digest.slice(0, 24).padEnd(24, "0")}`;
}

/** Insert in chunks — one giant createMany becomes one giant SQL statement. */
const CHUNK = 500;
async function insertAll<T>(
  label: string,
  rows: T[],
  write: (chunk: T[]) => Promise<unknown>
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await write(rows.slice(i, i + CHUNK));
  }
  console.log(`  ${label}: ${rows.length.toLocaleString()} rows`);
}

const TOPIC_NAMES = [
  "Thermodynamics",
  "Kinematics",
  "Electromagnetism",
  "Waves and Optics",
  "Stoichiometry",
  "Cell Biology",
];

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

// ─── Guard rails ──────────────────────────────────────────────────────────────

function assertBenchmarkTarget(url: string): string {
  const filePath = url.replace(/^file:/, "").split("?")[0];
  const base = path.basename(filePath).toLowerCase();
  const looksLikeBench = base.includes("bench");
  if (!looksLikeBench && process.env.BENCH_FORCE !== "1") {
    throw new Error(
      `Refusing to seed ${filePath}: the benchmark dataset is destructive and the ` +
        `target filename does not contain "bench". Point DATABASE_URL at a throwaway ` +
        `database (e.g. file:./data/bench.db), or set BENCH_FORCE=1 if you are certain.`
    );
  }
  return filePath;
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function main() {
  const url = resolveDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL is required");
  const dbPath = assertBenchmarkTarget(url);

  const adapter = new PrismaBetterSqlite3({ url, timeout: 15000 });
  const prisma = new PrismaClient({ adapter });

  // The seed is a long run of bulk writes; the same pragmas the app sets keep
  // it from being dominated by fsync.
  for (const pragma of [
    "PRAGMA journal_mode = WAL;",
    "PRAGMA synchronous = OFF;",
    "PRAGMA temp_store = MEMORY;",
    "PRAGMA cache_size = -131072;",
  ]) {
    await prisma.$queryRawUnsafe(pragma);
  }

  console.log(`Seeding benchmark dataset into ${dbPath}`);
  console.log(`  scale=${SCALE} seed=${CONFIG.seed}`);

  // Wipe in FK-safe order so reseeding an existing file is idempotent. Only
  // the tables this seed populates are touched.
  console.log("Clearing existing benchmark rows…");
  await prisma.examResult.deleteMany();
  await prisma.quizAnswer.deleteMany();
  await prisma.quizAttempt.deleteMany();
  await prisma.quizProgress.deleteMany();
  await prisma.classQuiz.deleteMany();
  await prisma.option.deleteMany();
  await prisma.question.deleteMany();
  await prisma.classEnrollment.deleteMany();
  await prisma.class.deleteMany();
  await prisma.quiz.deleteMany();
  await prisma.topic.deleteMany();
  await prisma.aiUseCaseAssignment.deleteMany();
  await prisma.aiModel.deleteMany();
  await prisma.aiProvider.deleteMany();
  await prisma.student.deleteMany();
  await prisma.teacher.deleteMany();
  await prisma.user.deleteMany();

  // One password, hashed once. Every login the load test performs still runs a
  // real cost-12 bcrypt.compare (the thing we care about measuring); hashing
  // once here just keeps seeding from taking an hour.
  const password = process.env.BENCH_PASSWORD || crypto.randomBytes(12).toString("base64url");
  const hashedPassword = await bcrypt.hash(password, CONFIG.bcryptCost);

  type SeedUser = { id: string; email: string; username: string; role: string };
  const users: (SeedUser & {
    hashedPassword: string;
    firstName: string;
    lastName: string;
    createdAt: Date;
  })[] = [];

  const admin = {
    id: bid("user"),
    email: "bench-admin@benchmark.invalid",
    username: "bench-admin",
    role: "ADMIN",
  };
  users.push({
    ...admin,
    hashedPassword,
    firstName: "Bench",
    lastName: "Admin",
    createdAt: daysAgo(200),
  });

  // ── Teachers ──
  const teachers: { id: string; userId: string; email: string; username: string }[] = [];
  for (let t = 0; t < CONFIG.teachers; t++) {
    const userId = bid("user");
    const email = `bench-teacher-${t}@benchmark.invalid`;
    const username = `bench-teacher-${t}`;
    users.push({
      id: userId,
      email,
      username,
      role: "TEACHER",
      hashedPassword,
      firstName: "Teacher",
      lastName: `T${t}`,
      createdAt: daysAgo(200),
    });
    teachers.push({ id: bid("teacher"), userId, email, username });
  }

  // ── Students ──
  const students: { id: string; userId: string; email: string; username: string }[] = [];
  const totalStudents = CONFIG.teachers * CONFIG.classesPerTeacher * CONFIG.studentsPerClass;
  for (let s = 0; s < totalStudents; s++) {
    const userId = bid("user");
    const email = `bench-student-${s}@benchmark.invalid`;
    const username = `bench-student-${s}`;
    users.push({
      id: userId,
      email,
      username,
      role: "STUDENT",
      hashedPassword,
      firstName: "Student",
      lastName: `S${s}`,
      createdAt: daysAgo(intBetween(30, 190)),
    });
    students.push({ id: bid("student"), userId, email, username });
  }

  await insertAll("User", users, (chunk) => prisma.user.createMany({ data: chunk }));
  await insertAll("Teacher", teachers, (chunk) =>
    prisma.teacher.createMany({ data: chunk.map(({ id, userId }) => ({ id, userId })) })
  );
  await insertAll("Student", students, (chunk) =>
    prisma.student.createMany({ data: chunk.map(({ id, userId }) => ({ id, userId })) })
  );

  // ── Topics + quizzes + questions ──
  const topics = TOPIC_NAMES.map((name, i) => ({
    id: bid("topic"),
    name,
    order: i,
    teacherId: teachers[i % teachers.length].id,
  }));
  await insertAll("Topic", topics, (chunk) => prisma.topic.createMany({ data: chunk }));

  const quizzes: { id: string; name: string; topicId: string; teacherId: string }[] = [];
  const questions: {
    id: string;
    quizId: string;
    text: string;
    answerMode: string;
    points: number;
    difficultyLevel: string;
    createdById: string;
    createdAt: Date;
    figureStorageKey: string | null;
    figureBucket: string | null;
    figureAlt: string | null;
    answerNumeric: number | null;
  }[] = [];
  const options: {
    id: string;
    questionId: string;
    text: string;
    isCorrect: boolean;
  }[] = [];
  /** questionId → correct option id (null for NUMERIC). Used by history + k6. */
  const correctByQuestion = new Map<string, string | null>();
  const questionsByQuiz = new Map<string, string[]>();

  const bucket = process.env.AWS_S3_BUCKET || "bench-bucket";

  for (let q = 0; q < CONFIG.quizzes; q++) {
    const topic = topics[q % topics.length];
    const quizId = bid("quiz");
    quizzes.push({
      id: quizId,
      name: `${topic.name} — Module ${Math.floor(q / topics.length) + 1}`,
      topicId: topic.id,
      teacherId: topic.teacherId,
    });
    const ids: string[] = [];

    for (let i = 0; i < CONFIG.questionsPerQuiz; i++) {
      const questionId = bid("question");
      ids.push(questionId);

      // Mode mix mirrors a real quiz: mostly single-select, some multi-select,
      // a few numeric. Each takes a different grading path in quiz-scoring.ts.
      const roll = rng();
      const answerMode = roll < 0.75 ? "SINGLE_SELECT" : roll < 0.9 ? "MULTI_SELECT" : "NUMERIC";
      const hasFigure = rng() < CONFIG.figureRatio;

      questions.push({
        id: questionId,
        quizId,
        text:
          `Q${i + 1}. ${topic.name}: given the conditions described, determine the ` +
          `resulting value and justify which principle applies.`,
        answerMode,
        points: pick([1, 1, 1, 2, 3]),
        difficultyLevel: pick(["BEGINNER", "INTERMEDIATE", "ADVANCED"]),
        createdById: topic.teacherId,
        // Spread createdAt so the `[quizId, createdAt]` index ordering is real.
        createdAt: daysAgo(200 - i),
        figureStorageKey: hasFigure ? `bench/figures/${questionId}.png` : null,
        figureBucket: hasFigure ? bucket : null,
        figureAlt: hasFigure ? "Benchmark figure placeholder" : null,
        answerNumeric: answerMode === "NUMERIC" ? Math.round(rng() * 10000) / 100 : null,
      });

      if (answerMode === "NUMERIC") {
        correctByQuestion.set(questionId, null);
        continue;
      }

      const correctIndex = intBetween(0, CONFIG.optionsPerQuestion - 1);
      // MULTI_SELECT needs a second correct choice; scoring requires the exact
      // set, so the history generator below reads these back.
      const secondCorrect =
        answerMode === "MULTI_SELECT"
          ? (correctIndex + 1) % CONFIG.optionsPerQuestion
          : -1;
      let firstCorrectId: string | null = null;
      for (let o = 0; o < CONFIG.optionsPerQuestion; o++) {
        const optionId = bid("option");
        const isCorrect = o === correctIndex || o === secondCorrect;
        if (isCorrect && firstCorrectId === null) firstCorrectId = optionId;
        options.push({
          id: optionId,
          questionId,
          text: `Option ${String.fromCharCode(65 + o)} — candidate explanation ${o + 1}`,
          isCorrect,
        });
      }
      correctByQuestion.set(questionId, firstCorrectId);
    }
    questionsByQuiz.set(quizId, ids);
  }

  await insertAll("Quiz", quizzes, (chunk) => prisma.quiz.createMany({ data: chunk }));
  await insertAll("Question", questions, (chunk) => prisma.question.createMany({ data: chunk }));
  await insertAll("Option", options, (chunk) => prisma.option.createMany({ data: chunk }));

  // ── Classes, enrollment, publication ──
  const classes: { id: string; name: string; teacherId: string; createdAt: Date }[] = [];
  const enrollments: { id: string; classId: string; studentId: string; joinedAt: Date }[] = [];
  const classQuizzes: {
    id: string;
    classId: string;
    quizId: string;
    published: boolean;
    maxAttempts: number | null;
  }[] = [];
  /** Per class: the quizzes the live load test is allowed to attempt. */
  const liveTargets: { classId: string; className: string; quizIds: string[] }[] = [];
  const studentClassMap = new Map<string, string[]>();

  let studentCursor = 0;
  for (const teacher of teachers) {
    for (let c = 0; c < CONFIG.classesPerTeacher; c++) {
      const classId = bid("class");
      const name = `${pick(TOPIC_NAMES)} ${2025 + (c % 2)} — Section ${c + 1}`;
      classes.push({ id: classId, name, teacherId: teacher.id, createdAt: daysAgo(190) });

      for (let s = 0; s < CONFIG.studentsPerClass; s++) {
        const student = students[studentCursor++];
        enrollments.push({
          id: bid("enrollment"),
          classId,
          studentId: student.id,
          joinedAt: daysAgo(intBetween(120, 185)),
        });
        const list = studentClassMap.get(student.id) ?? [];
        list.push(classId);
        studentClassMap.set(student.id, list);
      }

      // Every quiz is attached to the class; the last N are the "live" ones the
      // load test drives with unlimited attempts so VUs never hit the cap.
      const liveIds: string[] = [];
      quizzes.forEach((quiz, index) => {
        const isLive = index >= quizzes.length - CONFIG.liveQuizzesPerClass;
        if (isLive) liveIds.push(quiz.id);
        classQuizzes.push({
          id: bid("classquiz"),
          classId,
          quizId: quiz.id,
          published: true,
          // Historical quizzes keep a realistic cap; live ones are uncapped so
          // a soak run can submit thousands of attempts per student.
          maxAttempts: isLive ? null : 3,
        });
      });
      liveTargets.push({ classId, className: name, quizIds: liveIds });
    }
  }

  await insertAll("Class", classes, (chunk) => prisma.class.createMany({ data: chunk }));
  await insertAll("ClassEnrollment", enrollments, (chunk) =>
    prisma.classEnrollment.createMany({ data: chunk })
  );
  await insertAll("ClassQuiz", classQuizzes, (chunk) =>
    prisma.classQuiz.createMany({ data: chunk })
  );

  // ── History: completed attempts, answers, progress, exam results ──
  // Only non-live quizzes get history, so the live quizzes start clean and the
  // load test's own attempts are the only ones in them.
  const historyQuizzes = quizzes.slice(0, Math.max(1, quizzes.length - CONFIG.liveQuizzesPerClass));

  const attempts: {
    id: string;
    studentId: string;
    classId: string;
    quizId: string;
    score: number;
    startedAt: Date;
    completedAt: Date;
  }[] = [];
  const answers: {
    id: string;
    quizAttemptId: string;
    questionId: string;
    selectedOptionId: string | null;
    selectedOptionIds: string;
    numericValue: number | null;
    isCorrect: boolean;
  }[] = [];
  const progressRows = new Map<
    string,
    { id: string; studentId: string; classId: string; quizId: string; status: string; bestScore: number }
  >();
  const examResults: {
    id: string;
    quizAttemptId: string;
    studentId: string;
    classId: string;
    quizId: string;
    studentName: string;
    className: string;
    topicName: string;
    quizName: string;
    score: number;
    correctCount: number;
    totalCount: number;
    completedAt: Date;
    reviewSnapshot: string;
    summary: string | null;
    summaryStatus: string;
    recommendations: string | null;
    recommendationsStatus: string;
  }[] = [];

  const classById = new Map(classes.map((c) => [c.id, c]));
  const quizById = new Map(quizzes.map((q) => [q.id, q]));
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const optionsByQuestion = new Map<string, typeof options>();
  for (const option of options) {
    const list = optionsByQuestion.get(option.questionId) ?? [];
    list.push(option);
    optionsByQuestion.set(option.questionId, list);
  }

  for (const student of students) {
    const classIds = studentClassMap.get(student.id) ?? [];
    if (classIds.length === 0) continue;

    for (let a = 0; a < CONFIG.historyAttemptsPerStudent; a++) {
      const classId = pick(classIds);
      const quiz = pick(historyQuizzes);
      const questionIds = questionsByQuiz.get(quiz.id) ?? [];
      if (questionIds.length === 0) continue;

      const attemptId = bid("attempt");
      const completedAt = daysAgo(intBetween(1, 120));
      const startedAt = new Date(completedAt.getTime() - intBetween(4, 30) * 60_000);

      // Per-student ability, so score distributions look like a cohort rather
      // than uniform noise — the stats endpoints aggregate over these.
      const ability = 0.35 + makeRng(CONFIG.seed + student.id.length + a)() * 0.6;
      const answerRecords: {
        questionId: string;
        selectedOptionId: string | null;
        selectedOptionIds: string[];
        numericValue: number | null;
        isCorrect: boolean;
      }[] = [];

      let correct = 0;
      for (const questionId of questionIds) {
        const question = questionById.get(questionId)!;
        const gotItRight = rng() < ability;
        if (gotItRight) correct += 1;

        if (question.answerMode === "NUMERIC") {
          const truth = question.answerNumeric ?? 0;
          answerRecords.push({
            questionId,
            selectedOptionId: null,
            selectedOptionIds: [],
            numericValue: gotItRight ? truth : truth + 1 + rng() * 10,
            isCorrect: gotItRight,
          });
          continue;
        }

        const questionOptions = optionsByQuestion.get(questionId) ?? [];
        const correctIds = questionOptions.filter((o) => o.isCorrect).map((o) => o.id);
        const wrongIds = questionOptions.filter((o) => !o.isCorrect).map((o) => o.id);
        const chosen = gotItRight
          ? correctIds
          : wrongIds.length > 0
            ? [pick(wrongIds)]
            : correctIds.slice(0, 1);

        answerRecords.push({
          questionId,
          selectedOptionId: question.answerMode === "MULTI_SELECT" ? null : (chosen[0] ?? null),
          selectedOptionIds: question.answerMode === "MULTI_SELECT" ? chosen : [],
          numericValue: null,
          isCorrect: gotItRight,
        });
      }

      const score = Math.round((correct / questionIds.length) * 10000) / 100;
      attempts.push({
        id: attemptId,
        studentId: student.id,
        classId,
        quizId: quiz.id,
        score,
        startedAt,
        completedAt,
      });

      for (const record of answerRecords) {
        answers.push({
          id: bid("answer"),
          quizAttemptId: attemptId,
          questionId: record.questionId,
          selectedOptionId: record.selectedOptionId,
          selectedOptionIds: JSON.stringify(record.selectedOptionIds),
          numericValue: record.numericValue,
          isCorrect: record.isCorrect,
        });
      }

      const progressKey = `${student.id}:${classId}:${quiz.id}`;
      const existing = progressRows.get(progressKey);
      if (!existing) {
        progressRows.set(progressKey, {
          id: bid("progress"),
          studentId: student.id,
          classId,
          quizId: quiz.id,
          status: "COMPLETED",
          bestScore: score,
        });
      } else if (score > existing.bestScore) {
        existing.bestScore = score;
      }

      if (rng() < CONFIG.examResultRatio) {
        // The real snapshot builder, so historical rows parse exactly the way
        // the results page and the AI engine expect.
        const snapshot = buildReviewSnapshot(
          questionIds.map((questionId) => {
            const question = questionById.get(questionId)!;
            return {
              id: question.id,
              text: question.text,
              options: optionsByQuestion.get(questionId) ?? [],
              answerMode: question.answerMode,
              answerNumeric: question.answerNumeric,
              answerTolerance: null,
              answerUnit: null,
              figureStorageKey: question.figureStorageKey,
              figureAlt: question.figureAlt,
            };
          }),
          answerRecords.map((record) => ({
            questionId: record.questionId,
            selectedOptionId: record.selectedOptionId,
            selectedOptionIds: record.selectedOptionIds,
            numericValue: record.numericValue,
            isCorrect: record.isCorrect,
          }))
        );

        const klass = classById.get(classId)!;
        const quizRow = quizById.get(quiz.id)!;
        examResults.push({
          id: bid("examresult"),
          quizAttemptId: attemptId,
          studentId: student.id,
          classId,
          quizId: quiz.id,
          studentName: `Student S${students.indexOf(student)}`,
          className: klass.name,
          topicName: topicById.get(quizRow.topicId)?.name ?? "",
          quizName: quizRow.name,
          score,
          correctCount: correct,
          totalCount: questionIds.length,
          completedAt,
          reviewSnapshot: JSON.stringify(snapshot),
          summary:
            "Historical benchmark summary: the student shows partial mastery with " +
            "recurring errors in unit conversion and sign conventions.",
          summaryStatus: "READY",
          recommendations: JSON.stringify({ items: [], truncated: false }),
          recommendationsStatus: "READY",
        });
      }
    }
  }

  await insertAll("QuizAttempt", attempts, (chunk) => prisma.quizAttempt.createMany({ data: chunk }));
  await insertAll("QuizAnswer", answers, (chunk) => prisma.quizAnswer.createMany({ data: chunk }));
  await insertAll("QuizProgress", [...progressRows.values()], (chunk) =>
    prisma.quizProgress.createMany({ data: chunk })
  );
  await insertAll("ExamResult", examResults, (chunk) =>
    prisma.examResult.createMany({ data: chunk })
  );

  // ── AI provider pointed at the mock ───────────────────────────────────────
  // Every AI use case is assigned to a "local" provider whose baseUrl is the
  // mock server. Keeping real model calls out of the benchmark is what makes
  // runs reproducible (and free); benchmark/mock-ai/server.ts imposes a
  // configurable, deterministic latency instead.
  const providerId = bid("aiprovider");
  const modelId = bid("aimodel");
  await prisma.aiProvider.create({
    data: {
      id: providerId,
      name: "Benchmark Mock",
      providerType: "local",
      baseUrl: CONFIG.mockAiBaseUrl,
      isActive: true,
      timeoutMs: 30000,
    },
  });
  await prisma.aiModel.create({
    data: {
      id: modelId,
      providerId,
      modelId: "bench-mock-1",
      displayName: "Benchmark Mock Model",
      isDefault: true,
    },
  });
  const useCases = [
    "pdf_description",
    "description_generation",
    "recommendation",
    "quiz_extraction",
    "simulation_generation",
  ] as const;
  for (const useCase of useCases) {
    await prisma.aiUseCaseAssignment.create({
      data: { id: bid("aiassign"), useCase, providerId, modelId },
    });
  }
  console.log(`  AiProvider: mock at ${CONFIG.mockAiBaseUrl} (${useCases.length} use cases)`);

  // Leave the file compact and the statistics fresh, so the first query of a
  // benchmark run isn't paying for the seed's churn.
  await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE);");
  await prisma.$executeRawUnsafe("ANALYZE;");
  await prisma.$executeRawUnsafe("VACUUM;");

  // ── Manifest ──
  // The one artifact the rest of the harness reads: who to log in as, which
  // class/quiz pairs are safe to drive, and what the dataset actually contains.
  const manifest = {
    generatedAtIso: new Date().toISOString(),
    seed: CONFIG.seed,
    scale: SCALE,
    dbPath,
    password,
    config: CONFIG,
    counts: {
      users: users.length,
      teachers: teachers.length,
      students: students.length,
      classes: classes.length,
      quizzes: quizzes.length,
      questions: questions.length,
      options: options.length,
      attempts: attempts.length,
      answers: answers.length,
      examResults: examResults.length,
    },
    admin: { email: admin.email, username: admin.username },
    teachers: teachers.map((t) => ({ email: t.email, username: t.username })),
    // Each student is paired with one class + its live quizzes, so a k6 VU can
    // take a distinct identity with a single manifest lookup and no cross-talk.
    students: students.map((student) => {
      const classIds = studentClassMap.get(student.id) ?? [];
      const target = liveTargets.find((t) => t.classId === classIds[0]);
      return {
        email: student.email,
        username: student.username,
        studentId: student.id,
        classId: target?.classId ?? classIds[0] ?? null,
        quizIds: target?.quizIds ?? [],
      };
    }),
    classes: liveTargets,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifestPath = path.join(OUT_DIR, "dataset.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const stats = fs.statSync(dbPath);
  console.log(`\nDataset ready — ${(stats.size / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`Manifest: ${manifestPath}`);
  if (!process.env.BENCH_PASSWORD) {
    console.log(`Generated bench password (set BENCH_PASSWORD to pin it): ${password}`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
