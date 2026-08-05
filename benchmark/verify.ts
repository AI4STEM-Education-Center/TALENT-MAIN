import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";

const fixturePath = path.resolve(process.argv[2] || "benchmark/fixture.json");

async function main() {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const userIds = fixture.users.map((user: { id: string }) => user.id);
  const studentRows = await prisma.student.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  const studentIds = studentRows.map((student) => student.id);
  const since = new Date(fixture.generatedAt);

  const [completedAttempts, results, answers, pendingResults, notifications] = await Promise.all([
    prisma.quizAttempt.count({ where: { studentId: { in: studentIds }, completedAt: { gte: since } } }),
    prisma.examResult.count({ where: { studentId: { in: studentIds }, completedAt: { gte: since } } }),
    prisma.quizAnswer.count({
      where: { quizAttempt: { studentId: { in: studentIds }, completedAt: { gte: since } } },
    }),
    prisma.examResult.count({
      where: {
        studentId: { in: studentIds },
        completedAt: { gte: since },
        OR: [
          { summaryStatus: { in: ["PENDING", "GENERATING"] } },
          { recommendationsStatus: { in: ["PENDING", "GENERATING"] } },
        ],
      },
    }),
    prisma.notification.count({ where: { userId: { in: userIds }, createdAt: { gte: since } } }),
  ]);

  const report = {
    verifiedAt: new Date().toISOString(),
    completedAttempts,
    results,
    answers,
    pendingResults,
    notifications,
    invariants: {
      everyCompletedAttemptHasResult: completedAttempts === results,
      everyCompletedAttemptHasAnswers: completedAttempts === 0 || answers >= completedAttempts,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (!Object.values(report.invariants).every(Boolean)) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
