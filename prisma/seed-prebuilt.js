const { PrismaClient } = require("@prisma/client");
const {
  topic: prebuiltTopic,
  subtopics: prebuiltSubtopics,
  questions: prebuiltQuestions,
} = require("./prebuilt-questions.json");

const prisma = new PrismaClient();

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
