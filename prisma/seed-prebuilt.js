const path = require("node:path");
const { PrismaClient } = require("@prisma/client");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
const {
  topic: prebuiltTopic,
  subtopics: prebuiltSubtopics,
  questions: prebuiltQuestions,
} = require("./prebuilt-questions.json");

// Prisma 7's better-sqlite3 driver adapter must be passed explicitly — a bare
// `new PrismaClient()` throws "needs a non-empty, valid PrismaClientOptions".
// This script runs as plain CommonJS inside the production image (no tsx), so we
// inline the URL resolution from src/lib/db-url.ts instead of importing the .ts:
// a relative `file:` path must re-anchor to <cwd>/prisma, otherwise the adapter
// resolves it against cwd and we'd seed a *different* SQLite file than the app
// and `prisma db push` use. Keep in sync with src/lib/db-url.ts.
function resolveDatabaseUrl(raw = process.env.DATABASE_URL) {
  if (!raw || !raw.startsWith("file:")) return raw ?? "";
  const filePath = raw.slice("file:".length).split("?")[0];
  if (filePath === ":memory:") return raw;
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), "prisma", filePath);
  return `file:${absolute}`;
}

const adapter = new PrismaBetterSqlite3({ url: resolveDatabaseUrl() });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Backfilling prebuilt topic, quizzes, and questions...");

  const existingTopic = await prisma.topic.findFirst({
    where: {
      OR: [{ id: prebuiltTopic.id }, { name: prebuiltTopic.name }],
    },
    orderBy: { createdAt: "asc" },
  });

  const topic = existingTopic
    ? existingTopic
    : await prisma.topic.create({
        data: prebuiltTopic,
      });

  const quizIdMap = new Map();
  let createdTopicCount = existingTopic ? 0 : 1;
  let createdQuizCount = 0;

  for (const subtopicData of prebuiltSubtopics) {
    const existingQuiz = await prisma.quiz.findFirst({
      where: {
        topicId: topic.id,
        OR: [{ id: subtopicData.id }, { name: subtopicData.name }],
      },
      orderBy: { createdAt: "asc" },
    });

    const quiz = existingQuiz
      ? existingQuiz
      : await prisma.quiz.create({
          data: {
            ...subtopicData,
            topicId: topic.id,
          },
        });

    if (!existingQuiz) {
      createdQuizCount += 1;
    }

    quizIdMap.set(subtopicData.id, quiz.id);
  }

  let createdQuestionCount = 0;
  let skippedQuestionCount = 0;

  for (const questionData of prebuiltQuestions) {
    const quizId = quizIdMap.get(questionData.subtopicId);

    if (!quizId) {
      throw new Error(`Missing mapped quiz for ${questionData.subtopicId}`);
    }

    const existingQuestion = await prisma.question.findFirst({
      where: {
        text: questionData.text,
        quizId,
        createdById: null,
      },
    });

    if (existingQuestion) {
      skippedQuestionCount += 1;
      continue;
    }

    await prisma.question.create({
      data: {
        text: questionData.text,
        quizId,
        difficultyLevel: questionData.difficulty,
        options: {
          create: questionData.options,
        },
      },
    });

    createdQuestionCount += 1;
  }

  if (createdTopicCount === 0 && createdQuizCount === 0 && createdQuestionCount === 0) {
    console.log("Prebuilt questions already loaded. Nothing was added.");
    return;
  }

  console.log(`Created ${createdTopicCount} topic`);
  console.log(`Created ${createdQuizCount} quizzes`);
  console.log(`Created ${createdQuestionCount} prebuilt questions`);
  console.log(`Skipped ${skippedQuestionCount} existing prebuilt questions`);
  console.log("Prebuilt question backfill complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
