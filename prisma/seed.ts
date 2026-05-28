import { PrismaClient } from "@prisma/client";
import { prebuiltQuestions, prebuiltSubtopics, prebuiltTopic } from "./prebuilt-questions";

const prisma = new PrismaClient();

async function main() {
  console.log("Wiping database for clean seed...");

  await prisma.$transaction([
    prisma.quizAnswer.deleteMany(),
    prisma.quizAttempt.deleteMany(),
    prisma.moduleProgress.deleteMany(),
    prisma.classTopic.deleteMany(),
    prisma.classEnrollment.deleteMany(),
    prisma.invitation.deleteMany(),
    prisma.option.deleteMany(),
    prisma.question.deleteMany(),
    prisma.subtopic.deleteMany(),
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
      const subtopic = await prisma.subtopic.create({
        data: { ...subtopicData, topicId: topic.id },
      });
      console.log(`  Subtopic: ${subtopic.name}`);
    })
  );

  await Promise.all(
    prebuiltQuestions.map((questionData) =>
      prisma.question.create({
        data: {
          text: questionData.text,
          topicId: topic.id,
          subtopicId: questionData.subtopicId,
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
