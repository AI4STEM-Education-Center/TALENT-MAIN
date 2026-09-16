/**
 * Seed a benchmark cohort into a clone's database.
 *
 * WHY THIS EXISTS. The clone boots from a snapshot of production, and the
 * scenarios drive load as concurrent *students*. Production currently holds two
 * accounts — one ADMIN and one TEACHER — and zero students, classes or quizzes.
 * mint-sessions.ts does not fail on that: it warns, returns an empty student
 * list, and every student journey then has no identity to run as. So the clone
 * needs a cohort before sessions can be minted from it.
 *
 * WHERE IT RUNS. On the load generator, against the *copy* of the clone
 * database that run-ec2.sh already pulls across for minting. The seeded copy is
 * then pushed back to the clone, reusing the same stop/replace/start swap the
 * suite already performs between scenarios. The clone itself has no Node, and
 * adding one there would put a competing process on the single CPU the whole
 * measurement is about.
 *
 * WHAT IT IS NOT. This is not a substitute for real data and the report should
 * never imply otherwise. It is a synthetic cohort of uniform students answering
 * one uniform quiz, so it exercises row contention, the write path and the
 * event loop — not the distribution of a real classroom.
 *
 * Idempotent: every row it owns is prefixed `bench-`, looked up before insert,
 * so re-running against an already-seeded database tops up rather than
 * duplicates.
 *
 * Usage:
 *   tsx pressure/tools/seed-clone.ts --database-url file:/opt/pressure/mint.db \
 *     --students 800 --teachers 40 --questions 10 --password <pw>
 */

import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import bcrypt from "bcryptjs";
import { parseArgs, str, num } from "./args";

const PREFIX = "bench-";
const CONSENT_SIGNATURE = "Pressure Benchmark";

function log(message: string) {
  console.log(`[seed-clone] ${message}`);
}

async function main() {
  const args = parseArgs();
  const databaseUrl = str(args, "database-url", "");
  if (!databaseUrl) throw new Error("--database-url is required");

  const studentCount = num(args, "students", 800);
  const teacherCount = num(args, "teachers", 40);
  const adminCount = num(args, "admins", 2);
  const questionCount = num(args, "questions", 10);
  const password = str(args, "password", "");
  if (!password) throw new Error("--password is required (login-storm needs real credentials)");

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  // ONE hash, reused for every seeded account. Hashing 800 passwords at cost 12
  // with pure-JS bcryptjs would take minutes and measure nothing: the app only
  // ever calls bcrypt.compare, which is satisfied by any valid hash of the same
  // password. login-storm gets genuine credentials either way.
  log(`hashing the shared benchmark password once (cost 12)...`);
  const hashedPassword = await bcrypt.hash(password, 12);

  // Consent gates the proxy: with an active form published, an account with no
  // AGREE on that exact version is 403'd on every request, which would surface
  // as a wall of authorization failures rather than a capacity measurement.
  const activeStudentForm = await prisma.consentFormVersion.findFirst({
    where: { role: "STUDENT", isActive: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const activeTeacherForm = await prisma.consentFormVersion.findFirst({
    where: { role: "TEACHER", isActive: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  log(
    `active consent forms: student=${activeStudentForm ? "yes" : "none"} teacher=${activeTeacherForm ? "yes" : "none"}`,
  );

  async function recordConsent(userId: string, role: "STUDENT" | "TEACHER", name: string, email: string) {
    const form = role === "STUDENT" ? activeStudentForm : activeTeacherForm;
    if (!form) return;
    const existing = await prisma.consentRecord.findFirst({
      where: { userId, formVersionId: form.id },
      select: { id: true },
    });
    if (existing) return;
    await prisma.consentRecord.create({
      data: {
        userId,
        role,
        formVersionId: form.id,
        decision: "AGREE",
        signatureTypedName: CONSENT_SIGNATURE,
        ipAddress: "127.0.0.1",
        userAgent: "pressure-harness/seed-clone",
        deviceType: "BENCH",
        signerNameSnapshot: name,
        signerEmailSnapshot: email,
      },
    });
  }

  // ── Teachers ───────────────────────────────────────────────────────────────
  // Every minted teacher needs a class with a published quiz, or
  // teacherMonitorJourney has nothing to open.
  log(`ensuring ${teacherCount} benchmark teachers...`);
  const teacherIds: string[] = [];
  for (let i = 0; i < teacherCount; i++) {
    const username = `${PREFIX}teacher-${i}`;
    const email = `${username}@bench.invalid`;
    const firstName = "Bench";
    const lastName = `Teacher ${i}`;
    let user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, username, hashedPassword, firstName, lastName, role: "TEACHER" },
        select: { id: true },
      });
    }
    let teacher = await prisma.teacher.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!teacher) {
      teacher = await prisma.teacher.create({ data: { userId: user.id }, select: { id: true } });
    }
    await recordConsent(user.id, "TEACHER", `${firstName} ${lastName}`, email);
    teacherIds.push(teacher.id);
  }

  // ── Admins ─────────────────────────────────────────────────────────────────
  // run-ec2.sh mints 2. Production has 1, and minting only warns, so
  // admin-observability would silently hammer a single row.
  log(`ensuring ${adminCount} benchmark admins...`);
  for (let i = 0; i < adminCount; i++) {
    const username = `${PREFIX}admin-${i}`;
    const existing = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!existing) {
      await prisma.user.create({
        data: {
          email: `${username}@bench.invalid`,
          username,
          hashedPassword,
          firstName: "Bench",
          lastName: `Admin ${i}`,
          role: "ADMIN",
        },
      });
    }
  }

  // ── Consent backfill for accounts that came from the snapshot ──────────────
  // mint-sessions selects identities by id ascending, so the real production
  // teacher lands in the minted set. It has no AGREE against the active form,
  // and src/proxy.ts 403s every /api/ request from a gated account — its steps
  // would be recorded as designed_refusals rather than load, quietly biasing
  // the teacher numbers. Give every TEACHER and STUDENT a record.
  //
  // This writes a consent decision on behalf of a real account. That is
  // acceptable here and nowhere else: it happens only on the throwaway clone,
  // which cannot email, cannot reach S3, and is terminated at teardown. The
  // production database is never touched.
  if (activeStudentForm || activeTeacherForm) {
    const preExisting = await prisma.user.findMany({
      where: { role: { in: ["STUDENT", "TEACHER"] }, username: { not: { startsWith: PREFIX } } },
      select: { id: true, role: true, firstName: true, lastName: true, email: true },
    });
    for (const u of preExisting) {
      await recordConsent(
        u.id,
        u.role as "STUDENT" | "TEACHER",
        `${u.firstName} ${u.lastName}`,
        u.email,
      );
    }
    if (preExisting.length) log(`backfilled consent for ${preExisting.length} snapshot account(s)`);
  }

  // ── One topic + quiz + questions, owned by the first teacher ───────────────
  const ownerTeacherId = teacherIds[0];
  let topic = await prisma.topic.findFirst({
    where: { name: `${PREFIX}topic` },
    select: { id: true },
  });
  if (!topic) {
    topic = await prisma.topic.create({
      data: { name: `${PREFIX}topic`, order: 0, contentType: "QUIZ", teacherId: ownerTeacherId },
      select: { id: true },
    });
  }
  let quiz = await prisma.quiz.findFirst({
    where: { name: `${PREFIX}quiz` },
    select: { id: true },
  });
  if (!quiz) {
    quiz = await prisma.quiz.create({
      data: { name: `${PREFIX}quiz`, order: 0, topicId: topic.id, teacherId: ownerTeacherId },
      select: { id: true },
    });
  }

  const existingQuestions = await prisma.question.count({ where: { quizId: quiz.id } });
  if (existingQuestions < questionCount) {
    log(`creating ${questionCount - existingQuestions} questions with 4 options each...`);
    for (let q = existingQuestions; q < questionCount; q++) {
      const question = await prisma.question.create({
        data: {
          text: `Benchmark question ${q + 1}: which option is correct?`,
          quizId: quiz.id,
          difficultyLevel: "BEGINNER",
          answerMode: "SINGLE_SELECT",
          points: 1,
          createdById: ownerTeacherId,
        },
        select: { id: true },
      });
      await prisma.option.createMany({
        data: [0, 1, 2, 3].map((o) => ({
          text: `Option ${o + 1}`,
          isCorrect: o === 0,
          questionId: question.id,
        })),
      });
    }
  }

  // ── A class per teacher, each with the quiz published and always open ──────
  log(`ensuring one class per teacher with the quiz published...`);
  const classIds: string[] = [];
  for (let i = 0; i < teacherIds.length; i++) {
    const name = `${PREFIX}class-${i}`;
    let klass = await prisma.class.findFirst({ where: { name }, select: { id: true } });
    if (!klass) {
      klass = await prisma.class.create({
        data: { name, description: "Pressure benchmark class", teacherId: teacherIds[i] },
        select: { id: true },
      });
    }
    const link = await prisma.classQuiz.findFirst({
      where: { classId: klass.id, quizId: quiz.id },
      select: { id: true },
    });
    if (!link) {
      // availableFrom/Until null = always open, maxAttempts null = unlimited.
      // Both matter: a closed quiz or an exhausted attempt cap returns 403,
      // which the journeys treat as *designed* and would silently drop every
      // sample, leaving thresholds to pass on an empty dataset.
      await prisma.classQuiz.create({
        data: { classId: klass.id, quizId: quiz.id, published: true },
      });
    }
    classIds.push(klass.id);
  }

  // ── Students ───────────────────────────────────────────────────────────────
  // All of them enrol in class 0, because that is where the scenarios' intended
  // contention lives — one cohort hitting one quiz. Each additional teacher's
  // class gets a slice as well so teacher stats is not aggregating nothing.
  const primaryClassId = classIds[0];
  const sliceSize = Math.min(studentCount, 50);
  log(`ensuring ${studentCount} benchmark students enrolled in ${PREFIX}class-0...`);

  let created = 0;
  for (let i = 0; i < studentCount; i++) {
    const username = `${PREFIX}student-${i}`;
    const email = `${username}@bench.invalid`;
    const firstName = "Bench";
    const lastName = `Student ${i}`;
    let user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, username, hashedPassword, firstName, lastName, role: "STUDENT" },
        select: { id: true },
      });
      created++;
    }
    let student = await prisma.student.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!student) {
      student = await prisma.student.create({ data: { userId: user.id }, select: { id: true } });
    }
    await recordConsent(user.id, "STUDENT", `${firstName} ${lastName}`, email);

    const targets = new Set<string>([primaryClassId]);
    if (i < sliceSize) for (const c of classIds.slice(1)) targets.add(c);
    for (const classId of targets) {
      const enrolled = await prisma.classEnrollment.findFirst({
        where: { classId, studentId: student.id },
        select: { id: true },
      });
      if (!enrolled) {
        await prisma.classEnrollment.create({ data: { classId, studentId: student.id } });
      }
    }

    if ((i + 1) % 200 === 0) log(`  ...${i + 1}/${studentCount} students`);
  }

  const totals = {
    students: await prisma.user.count({ where: { role: "STUDENT" } }),
    teachers: await prisma.user.count({ where: { role: "TEACHER" } }),
    admins: await prisma.user.count({ where: { role: "ADMIN" } }),
    classes: await prisma.class.count(),
    questions: await prisma.question.count({ where: { quizId: quiz.id } }),
    enrollments: await prisma.classEnrollment.count(),
  };
  log(`seeded (${created} students newly created). Totals: ${JSON.stringify(totals)}`);

  if (totals.students < studentCount) {
    throw new Error(
      `expected at least ${studentCount} students after seeding but the database has ${totals.students}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(`[seed-clone] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
