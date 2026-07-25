import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

/**
 * Delete every row in foreign-key-safe order. Called in beforeEach by Tier 2
 * specs so each test starts from an empty, deterministic database. Files run
 * serially (fileParallelism: false), so there is never a concurrent writer.
 */
export async function resetDb() {
  // Children first, parents last.
  await prisma.systemLog.deleteMany();
  await prisma.quizAnswer.deleteMany();
  await prisma.quizAttempt.deleteMany();
  await prisma.quizProgress.deleteMany();
  await prisma.option.deleteMany();
  // Simulation rows cascade from Question, but SimulationSession is relation-free
  // (see schema) — clear all three explicitly so nothing bleeds between specs.
  await prisma.simulationFeedback.deleteMany();
  await prisma.questionSimulation.deleteMany();
  await prisma.simulationSession.deleteMany();
  await prisma.question.deleteMany();
  await prisma.questionImport.deleteMany();
  await prisma.classQuiz.deleteMany();
  await prisma.quiz.deleteMany();
  await prisma.topic.deleteMany();
  await prisma.materialPage.deleteMany();
  await prisma.materialClass.deleteMany();
  await prisma.learningMaterial.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.classEnrollment.deleteMany();
  await prisma.classStudentList.deleteMany();
  await prisma.class.deleteMany();
  await prisma.aiUseCaseAssignment.deleteMany();
  await prisma.aiModel.deleteMany();
  await prisma.aiProvider.deleteMany();
  await prisma.teacher.deleteMany();
  await prisma.student.deleteMany();
  await prisma.user.deleteMany();
}

let seq = 0;
function uniq(prefix: string) {
  seq += 1;
  return `${prefix}-${seq}`;
}

export async function createTeacher(overrides: Partial<{ email: string; username: string }> = {}) {
  const tag = uniq("teacher");
  const user = await prisma.user.create({
    data: {
      email: overrides.email ?? `${tag}@example.com`,
      username: overrides.username ?? tag,
      hashedPassword: await bcrypt.hash("Password1!", 10),
      firstName: "Tess",
      lastName: "Teacher",
      role: "TEACHER",
      teacher: { create: {} },
    },
    include: { teacher: true },
  });
  return { user, teacher: user.teacher! };
}

export async function createStudent(overrides: Partial<{ email: string; username: string }> = {}) {
  const tag = uniq("student");
  const user = await prisma.user.create({
    data: {
      email: overrides.email ?? `${tag}@example.com`,
      username: overrides.username ?? tag,
      hashedPassword: await bcrypt.hash("Password1!", 10),
      firstName: "Stu",
      lastName: "Student",
      role: "STUDENT",
      student: { create: {} },
    },
    include: { student: true },
  });
  return { user, student: user.student! };
}

export async function createClass(teacherId: string, name = "Physics 101") {
  return prisma.class.create({ data: { name, teacherId } });
}

/**
 * Build a published quiz (with an optional topic label) + a single/multi-select
 * question with options. Returns the ids a quiz flow needs.
 */
export async function createPublishedQuiz(opts: {
  classId: string;
  teacherId?: string;
  answerMode?: "SINGLE_SELECT" | "MULTI_SELECT";
  published?: boolean;
}) {
  const { classId, teacherId, answerMode = "SINGLE_SELECT", published = true } = opts;
  const topic = await prisma.topic.create({ data: { name: uniq("topic"), teacherId: teacherId ?? null } });
  const quiz = await prisma.quiz.create({
    data: { name: uniq("quiz"), topicId: topic.id, teacherId: teacherId ?? null },
  });
  await prisma.classQuiz.create({ data: { classId, quizId: quiz.id, published } });

  const question = await prisma.question.create({
    data: {
      text: "What is 2 + 2?",
      quizId: quiz.id,
      answerMode,
      options: {
        create: [
          { text: "3", isCorrect: false },
          { text: "4", isCorrect: true },
          { text: "5", isCorrect: answerMode === "MULTI_SELECT" }, // 2nd correct only for multi
        ],
      },
    },
    include: { options: true },
  });

  return { topic, quiz, question };
}
