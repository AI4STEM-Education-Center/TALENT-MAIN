import { writeFile } from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { encode } from "next-auth/jwt";
import { prisma } from "../src/lib/prisma";

const PREFIX = "gpt56_benchmark_";
const PASSWORD = process.env.BENCHMARK_PASSWORD || "Benchmark-Only-56!";
const STUDENTS = positiveInt("BENCHMARK_STUDENTS", 60);
const CLASSES = positiveInt("BENCHMARK_CLASSES", 2);
const QUIZZES = positiveInt("BENCHMARK_QUIZZES", 6);
const QUESTIONS = positiveInt("BENCHMARK_QUESTIONS", 12);
const HISTORY = nonNegativeInt("BENCHMARK_HISTORY", 2);
const outputArg = process.argv.indexOf("--out");
const outputPath = path.resolve(
  outputArg >= 0 && process.argv[outputArg + 1]
    ? process.argv[outputArg + 1]
    : "benchmark/fixture.json"
);

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function assertSafeTarget(): void {
  const appEnv = (process.env.APP_ENV || "").toLowerCase();
  const databaseUrl = (process.env.DATABASE_URL || "").toLowerCase().replace(/\\/g, "/");
  if (process.env.BENCHMARK_ALLOW_MUTATION !== "1") {
    throw new Error("Refusing to mutate data: set BENCHMARK_ALLOW_MUTATION=1 explicitly");
  }
  if (!["benchmark", "perf", "test"].includes(appEnv)) {
    throw new Error(`Refusing APP_ENV=${appEnv || "<unset>"}; use benchmark, perf, or test`);
  }
  if (/(^|\/)prod\.db(?:$|\?)/.test(databaseUrl) || databaseUrl.includes("/data/db/prod/")) {
    throw new Error("Refusing a database URL that appears to be production");
  }
  if (!process.env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required to create per-user benchmark sessions");
  }
}

type ManifestQuestion = {
  id: string;
  mode: string;
  correctOptionIds: string[];
  wrongOptionId: string | null;
  numericAnswer: number | null;
};

async function sessionTokens(user: {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  role: string;
}) {
  const token = {
    sub: user.id,
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
  };
  const secret = process.env.AUTH_SECRET!;
  return {
    local: await encode({ token, secret, salt: "authjs.session-token" }),
    secure: await encode({ token, secret, salt: "__Secure-authjs.session-token" }),
  };
}

async function main() {
  assertSafeTarget();

  // The prefix is the cleanup boundary. No non-benchmark row is selected.
  await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });

  const hashedPassword = await bcrypt.hash(PASSWORD, 12);
  const teacherUser = await prisma.user.create({
    data: {
      email: `${PREFIX}teacher@example.invalid`,
      username: `${PREFIX}teacher`,
      hashedPassword,
      firstName: "Benchmark",
      lastName: "Teacher",
      role: "TEACHER",
      teacher: { create: {} },
    },
    include: { teacher: true },
  });
  const teacher = teacherUser.teacher!;
  const topic = await prisma.topic.create({
    data: { name: "GPT-5.6 Performance Science", order: 1, teacherId: teacher.id },
  });

  const quizzes: Array<{ id: string; questions: ManifestQuestion[] }> = [];
  for (let quizIndex = 0; quizIndex < QUIZZES; quizIndex++) {
    const quiz = await prisma.quiz.create({
      data: {
        name: `Benchmark Quiz ${quizIndex + 1}`,
        order: quizIndex + 1,
        teacherId: teacher.id,
        topicId: topic.id,
      },
    });
    const manifestQuestions: ManifestQuestion[] = [];
    for (let questionIndex = 0; questionIndex < QUESTIONS; questionIndex++) {
      const variant = questionIndex % 5;
      if (variant === 0) {
        const numericAnswer = 20 + questionIndex;
        const question = await prisma.question.create({
          data: {
            quizId: quiz.id,
            createdById: teacher.id,
            text: `Calculate benchmark quantity ${questionIndex + 1}.`,
            difficultyLevel: "INTERMEDIATE",
            answerMode: "NUMERIC",
            answerNumeric: numericAnswer,
            answerTolerance: 0.1,
            answerUnit: "J",
            points: 2,
          },
        });
        manifestQuestions.push({
          id: question.id,
          mode: "NUMERIC",
          correctOptionIds: [],
          wrongOptionId: null,
          numericAnswer,
        });
        continue;
      }

      const multi = variant === 1;
      const question = await prisma.question.create({
        data: {
          quizId: quiz.id,
          createdById: teacher.id,
          text: `Benchmark concept question ${questionIndex + 1}?`,
          difficultyLevel: variant === 4 ? "ADVANCED" : "BEGINNER",
          answerMode: multi ? "MULTI_SELECT" : "SINGLE_SELECT",
          points: multi ? 2 : 1,
          options: {
            create: [
              { text: "Correct principle", isCorrect: true },
              { text: "Related correct principle", isCorrect: multi },
              { text: "Plausible misconception", isCorrect: false },
              { text: "Unrelated statement", isCorrect: false },
            ],
          },
        },
        include: { options: true },
      });
      manifestQuestions.push({
        id: question.id,
        mode: question.answerMode,
        correctOptionIds: question.options.filter((option) => option.isCorrect).map((option) => option.id),
        wrongOptionId: question.options.find((option) => !option.isCorrect)?.id ?? null,
        numericAnswer: null,
      });
    }
    quizzes.push({ id: quiz.id, questions: manifestQuestions });
  }

  const classes = [];
  for (let classIndex = 0; classIndex < CLASSES; classIndex++) {
    const cls = await prisma.class.create({
      data: {
        name: `Benchmark Physics ${classIndex + 1}`,
        description: "Disposable GPT-5.6 performance-test fixture",
        teacherId: teacher.id,
      },
    });
    await prisma.classQuiz.createMany({
      data: quizzes.map((quiz) => ({ classId: cls.id, quizId: quiz.id, published: true })),
    });
    classes.push(cls);
  }

  const users = [];
  for (let studentIndex = 0; studentIndex < STUDENTS; studentIndex++) {
    const classIndex = studentIndex % classes.length;
    const quizIndex = studentIndex % quizzes.length;
    const username = `${PREFIX}student_${String(studentIndex + 1).padStart(4, "0")}`;
    const email = `${username}@example.invalid`;
    const orgDefinedId = `81${String(studentIndex + 1).padStart(7, "0")}`;
    const user = await prisma.user.create({
      data: {
        email,
        username,
        hashedPassword,
        firstName: "Load",
        lastName: `Student ${studentIndex + 1}`,
        role: "STUDENT",
        student: { create: {} },
      },
      include: { student: true },
    });
    const cls = classes[classIndex];
    const quiz = quizzes[quizIndex];
    await prisma.$transaction([
      prisma.classEnrollment.create({ data: { classId: cls.id, studentId: user.student!.id } }),
      prisma.classStudentList.create({
        data: {
          classId: cls.id,
          orgDefinedId,
          firstName: user.firstName,
          lastName: user.lastName,
          email,
          isRegistered: true,
        },
      }),
    ]);

    for (let historyIndex = 0; historyIndex < HISTORY; historyIndex++) {
      const completedAt = new Date(Date.now() - (historyIndex + 1) * 86_400_000);
      const attempt = await prisma.quizAttempt.create({
        data: {
          studentId: user.student!.id,
          classId: cls.id,
          quizId: quiz.id,
          score: 75,
          completedAt,
        },
      });
      await prisma.quizAnswer.createMany({
        data: quiz.questions.map((question, index) => ({
          quizAttemptId: attempt.id,
          questionId: question.id,
          selectedOptionId: question.mode === "SINGLE_SELECT" ? question.correctOptionIds[0] ?? null : null,
          selectedOptionIds: JSON.stringify(question.correctOptionIds),
          numericValue: question.numericAnswer,
          isCorrect: index % 4 !== 0,
        })),
      });
      await prisma.examResult.create({
        data: {
          quizAttemptId: attempt.id,
          studentId: user.student!.id,
          classId: cls.id,
          quizId: quiz.id,
          studentName: `${user.firstName} ${user.lastName}`,
          className: cls.name,
          topicName: topic.name,
          quizName: `Benchmark Quiz ${quizIndex + 1}`,
          score: 75,
          correctCount: Math.floor(QUESTIONS * 0.75),
          totalCount: QUESTIONS,
          completedAt,
          reviewSnapshot: "[]",
          summary: "Archived benchmark result.",
          summaryStatus: "READY",
          recommendations: JSON.stringify({ items: [], truncated: false }),
          recommendationsStatus: "READY",
        },
      });
    }
    await prisma.quizProgress.create({
      data: {
        studentId: user.student!.id,
        classId: cls.id,
        quizId: quiz.id,
        status: HISTORY > 0 ? "COMPLETED" : "NOT_STARTED",
        bestScore: HISTORY > 0 ? 75 : null,
      },
    });

    users.push({
      id: user.id,
      username,
      password: PASSWORD,
      classId: cls.id,
      quizId: quiz.id,
      questions: quiz.questions,
      session: await sessionTokens(user),
    });
  }

  for (const cls of classes) {
    const recipients = users.filter((user) => user.classId === cls.id);
    const message = await prisma.message.create({
      data: {
        classId: cls.id,
        direction: "TEACHER_TO_STUDENTS",
        channels: "IN_APP",
        senderUserId: teacherUser.id,
        subject: "Benchmark class announcement",
        body: "This disposable message makes notification reads representative.",
        inAppCount: recipients.length,
        status: "SENT",
      },
    });
    await prisma.notification.createMany({
      data: recipients.map((recipient) => ({ messageId: message.id, userId: recipient.id })),
    });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: "GPT-5.6",
    counts: { students: STUDENTS, classes: CLASSES, quizzes: QUIZZES, questionsPerQuiz: QUESTIONS, historyPerStudent: HISTORY },
    teacher: {
      id: teacherUser.id,
      username: teacherUser.username,
      password: PASSWORD,
      classIds: classes.map((cls) => cls.id),
      quizIds: quizzes.map((quiz) => quiz.id),
      session: await sessionTokens(teacherUser),
    },
    users,
  };
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Created ${STUDENTS} users across ${CLASSES} classes; manifest: ${outputPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
