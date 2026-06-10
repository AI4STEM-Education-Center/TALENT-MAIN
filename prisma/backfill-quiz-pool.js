// ONE-TIME backfill for the quiz-ownership rework (teacher-scoped quizzes +
// admin-managed global pool). Moves ALL pre-existing topics, quizzes and
// questions into the global pool (teacherId/createdById = NULL); teachers
// re-import what they need as their own independent copies.
//
// Student history is untouched: QuizAttempt/QuizAnswer/QuizProgress rows keep
// pointing at the (now pool-owned) quiz ids, and ExamResult snapshots are
// relation-free anyway. The old ClassTopic assignments are dropped by the
// schema push itself — teachers re-assign and re-publish their imported copies.
//
// Runs on every dev deploy until removed (see deploy-dev.yml), so it guards
// itself with a marker file on the persistent DB volume and is a no-op after
// the first successful run. Delete this file + its workflow step once the dev
// deploy has run it.
const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");

const MARKER = path.join(__dirname, "data", "backfill-quiz-pool.done");

async function main() {
  if (fs.existsSync(MARKER)) {
    console.log("[backfill-quiz-pool] Already ran on this database. Skipping.");
    return;
  }

  const prisma = new PrismaClient();
  try {
    const [topics, quizzes, questions] = await prisma.$transaction([
      prisma.topic.updateMany({ data: { teacherId: null } }),
      prisma.quiz.updateMany({ data: { teacherId: null } }),
      prisma.question.updateMany({ data: { createdById: null } }),
    ]);
    console.log(
      `[backfill-quiz-pool] Moved to global pool: ${topics.count} topics, ${quizzes.count} quizzes (${questions.count} questions).`
    );
    fs.writeFileSync(MARKER, new Date().toISOString() + "\n");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[backfill-quiz-pool] FAILED:", e);
  process.exit(1);
});
