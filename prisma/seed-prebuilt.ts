import { PrismaClient } from "@prisma/client";
import { prebuiltQuestions, prebuiltSubtopics, prebuiltTopic } from "./prebuilt-questions";

const prisma = new PrismaClient();

async function main() {
  console.log("Backfilling prebuilt topic, subtopics, and questions...");

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

  const subtopicIdMap = new Map<string, string>();
  let createdTopicCount = existingTopic ? 0 : 1;
  let createdSubtopicCount = 0;

  for (const subtopicData of prebuiltSubtopics) {
    const existingSubtopic = await prisma.subtopic.findFirst({
      where: {
        topicId: topic.id,
        OR: [{ id: subtopicData.id }, { name: subtopicData.name }],
      },
      orderBy: { createdAt: "asc" },
    });

    const subtopic = existingSubtopic
      ? existingSubtopic
      : await prisma.subtopic.create({
          data: {
            ...subtopicData,
            topicId: topic.id,
          },
        });

    if (!existingSubtopic) {
      createdSubtopicCount += 1;
    }

    subtopicIdMap.set(subtopicData.id, subtopic.id);
  }

  let createdCount = 0;
  let skippedCount = 0;

  for (const questionData of prebuiltQuestions) {
    const subtopicId = subtopicIdMap.get(questionData.subtopicId);

    if (!subtopicId) {
      throw new Error(`Missing mapped subtopic for ${questionData.subtopicId}`);
    }

    const existingQuestion = await prisma.question.findFirst({
      where: {
        text: questionData.text,
        topicId: topic.id,
        subtopicId,
        createdById: null,
      },
    });

    if (existingQuestion) {
      skippedCount += 1;
      continue;
    }

    await prisma.question.create({
      data: {
        text: questionData.text,
        topicId: topic.id,
        subtopicId,
        difficultyLevel: questionData.difficulty,
        options: {
          create: questionData.options,
        },
      },
    });

    createdCount += 1;
  }

  if (createdTopicCount === 0 && createdSubtopicCount === 0 && createdCount === 0) {
    console.log("Prebuilt questions already loaded. Nothing was added.");
    return;
  }

  console.log(`Created ${createdTopicCount} topic`);
  console.log(`Created ${createdSubtopicCount} subtopics`);
  console.log(`Created ${createdCount} prebuilt questions`);
  console.log(`Skipped ${skippedCount} existing prebuilt questions`);
  console.log("Prebuilt question backfill complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
