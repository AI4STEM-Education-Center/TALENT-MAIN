import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { prebuiltQuestions, prebuiltSubtopics, prebuiltTopic } from "./prebuilt-questions";
import { resolveDatabaseUrl } from "../src/lib/db-url";

const adapter = new PrismaBetterSqlite3({ url: resolveDatabaseUrl() });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Wiping database for clean seed...");

  await prisma.$transaction([
    prisma.quizAnswer.deleteMany(),
    prisma.quizAttempt.deleteMany(),
    prisma.quizProgress.deleteMany(),
    prisma.classQuiz.deleteMany(),
    prisma.classEnrollment.deleteMany(),
    prisma.invitation.deleteMany(),
    prisma.option.deleteMany(),
    prisma.question.deleteMany(),
    prisma.quiz.deleteMany(),
    prisma.topic.deleteMany(),
    prisma.class.deleteMany(),
    prisma.student.deleteMany(),
    prisma.teacher.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  console.log("Database wiped. Seeding fresh data...");

  const topic = await prisma.topic.create({
    data: prebuiltTopic,
  });

  console.log(`Topic: ${topic.name}`);

  await Promise.all(
    prebuiltSubtopics.map(async (subtopicData) => {
      const quiz = await prisma.quiz.create({
        data: { ...subtopicData, topicId: topic.id },
      });
      console.log(`  Quiz: ${quiz.name}`);
    })
  );

  await Promise.all(
    prebuiltQuestions.map((questionData) =>
      prisma.question.create({
        data: {
          text: questionData.text,
          quizId: questionData.subtopicId,
          difficultyLevel: questionData.difficulty,
          options: { create: questionData.options },
        },
      })
    )
  );

  console.log(`Seeded ${prebuiltQuestions.length} questions`);
  console.log("\nSeed complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
