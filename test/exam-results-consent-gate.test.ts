import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { generateExamResult } from "@/lib/exam-results-engine";
import { prisma } from "@/lib/prisma";
import { createStudent, createTeacher, resetDb } from "./db";

beforeEach(resetDb);

afterAll(async () => {
  await prisma.$disconnect();
});

async function publishStudentForm() {
  return prisma.consentFormVersion.create({
    data: {
      role: "STUDENT",
      version: "v1",
      title: "Student form",
      bodyHtml: "<p>hello</p>",
      isActive: true,
    },
  });
}

async function agree(userId: string, formVersionId: string, email: string) {
  await prisma.consentRecord.create({
    data: {
      userId,
      role: "STUDENT",
      formVersionId,
      decision: "AGREE",
      signatureTypedName: "Stu Student",
      ipAddress: "127.0.0.1",
      userAgent: "test",
      deviceType: "desktop",
      signerNameSnapshot: "Stu Student",
      signerEmailSnapshot: email,
    },
  });
}

/**
 * ExamResult.studentId holds a Student.id, while ConsentRecord is keyed by
 * User.id. Nothing in the type system distinguishes the two cuids, so these
 * cover the gate with a student whose profile id and user id differ.
 */
async function seedExamResult(studentId: string) {
  const { teacher } = await createTeacher();
  const cls = await prisma.class.create({ data: { name: "Physics 101", teacherId: teacher.id } });
  const quiz = await prisma.quiz.create({ data: { name: "Quiz 1", teacherId: teacher.id } });
  const examResult = await prisma.examResult.create({
    data: {
      quizAttemptId: `attempt-${studentId}`,
      studentId,
      classId: cls.id,
      quizId: quiz.id,
      className: cls.name,
      topicName: "Waves",
      quizName: "Quiz 1",
      score: 100,
      correctCount: 1,
      totalCount: 1,
      completedAt: new Date(),
      // No incorrect questions, so the recommendations section terminates
      // without an LLM call and only the summary exercises the provider path.
      reviewSnapshot: JSON.stringify({ questions: [{ text: "Q1", isCorrect: true }] }),
    },
  });
  return examResult;
}

describe("generateExamResult research-consent gate", () => {
  it("generates for a student who agreed, keyed by their User id not their Student id", async () => {
    const form = await publishStudentForm();
    const { user, student } = await createStudent();
    await agree(user.id, form.id, user.email);
    expect(student.id).not.toBe(user.id);

    const examResult = await seedExamResult(student.id);
    await generateExamResult(examResult.id);

    // No AI provider is configured in the test database, so the summary lands
    // on FAILED. That is the point: reaching the provider at all proves the
    // consent gate resolved Student -> User instead of skipping the attempt.
    const after = await prisma.examResult.findUniqueOrThrow({ where: { id: examResult.id } });
    expect(after.summaryStatus).not.toBe("SKIPPED_NO_CONSENT");
    expect(after.summaryStatus).toBe("FAILED");
  });

  it("skips a student who never signed the active form", async () => {
    await publishStudentForm();
    const { student } = await createStudent();

    const examResult = await seedExamResult(student.id);
    await generateExamResult(examResult.id);

    const after = await prisma.examResult.findUniqueOrThrow({ where: { id: examResult.id } });
    expect(after.summaryStatus).toBe("SKIPPED_NO_CONSENT");
    expect(after.recommendationsStatus).toBe("SKIPPED_NO_CONSENT");
  });
});
