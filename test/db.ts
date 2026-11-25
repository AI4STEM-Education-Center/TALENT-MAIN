import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

/**
 * Delete every row in foreign-key-safe order in a single transaction so each
 * test starts from an empty, deterministic per-worker SQLite database.
 */
export async function resetDb() {
  // Children first, parents last.
  await prisma.$transaction([
    prisma.wrongAnswerCoachMessage.deleteMany(),
    prisma.wrongAnswerCoachResearchMeta.deleteMany(),
    prisma.wrongAnswerCoachSession.deleteMany(),
    prisma.studentStudyCode.deleteMany(),
    prisma.questionCoachMetadata.deleteMany(),
    prisma.sessionRecording.deleteMany(),
    prisma.quizVariantEmailDelivery.deleteMany(),
    prisma.quizVariantBatchState.deleteMany(),
    prisma.quizPracticeAttempt.deleteMany(),
    prisma.quizPracticeVersion.deleteMany(),
    prisma.systemLog.deleteMany(),
    prisma.pressureResultToken.deleteMany(),
    prisma.pressureTestResult.deleteMany(),
    prisma.researchEmailDelivery.deleteMany(),
    prisma.researchEmailCampaign.deleteMany(),
    prisma.researchEmailTemplate.deleteMany(),
    prisma.surveyInvite.deleteMany(),
    prisma.surveyPromptDismissal.deleteMany(),
    prisma.consentRepromptDismissal.deleteMany(),
    prisma.surveyResponse.deleteMany(),
    prisma.surveyForm.deleteMany(),
    prisma.consentExportJob.deleteMany(),
    prisma.consentEmailDelivery.deleteMany(),
    prisma.consentExportRequest.deleteMany(),
    prisma.consentRecord.deleteMany(),
    prisma.consentFormVersion.deleteMany(),
    prisma.consentExportSettings.deleteMany(),
    prisma.messageEmailDelivery.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.message.deleteMany(),
    prisma.quizAnswer.deleteMany(),
    prisma.quizAttempt.deleteMany(),
    // Relation-free (see schema): nothing cascades it away, so clear it
    // explicitly or archived results bleed into the next spec file.
    prisma.examResult.deleteMany(),
    prisma.quizProgress.deleteMany(),
    prisma.option.deleteMany(),
    // Simulation rows cascade from Question, but SimulationSession is
    // relation-free (see schema) — clear all three explicitly so nothing bleeds
    // between specs.
    prisma.simulationFeedback.deleteMany(),
    prisma.questionSimulation.deleteMany(),
    prisma.simulationSession.deleteMany(),
    // Relation-free like SimulationSession: reading sessions outlive materials.
    prisma.learningResourceSession.deleteMany(),
    // Relation-free (see schema): a rating outlives the account, simulation and
    // class it is about, so nothing cascades it away.
    prisma.contentFeedback.deleteMany(),
    prisma.question.deleteMany(),
    prisma.questionImport.deleteMany(),
    prisma.classQuiz.deleteMany(),
    prisma.poolSubmission.deleteMany(),
    prisma.quiz.deleteMany(),
    prisma.topic.deleteMany(),
    prisma.materialPage.deleteMany(),
    prisma.materialClass.deleteMany(),
    prisma.learningMaterial.deleteMany(),
    prisma.invitation.deleteMany(),
    prisma.classEnrollment.deleteMany(),
    prisma.classStudentList.deleteMany(),
    prisma.class.deleteMany(),
    prisma.aiUseCaseAssignment.deleteMany(),
    prisma.aiModel.deleteMany(),
    prisma.aiProvider.deleteMany(),
    prisma.passwordResetToken.deleteMany(),
    // Relation-free (see schema): admin-issued teacher signup codes outlive the
    // admin who made them, so nothing cascades them away.
    prisma.teacherRegistrationCode.deleteMany(),
    prisma.teacher.deleteMany(),
    prisma.student.deleteMany(),
    prisma.user.deleteMany(),
    // Config singletons/overrides are relation-free but leak across specs.
    prisma.emailSender.deleteMany(),
    prisma.smtpConfig.deleteMany(),
    prisma.assistantConfig.deleteMany(),
    prisma.guardrailFeedback.deleteMany(),
    prisma.guardrailEvent.deleteMany(),
    prisma.guardrailConfig.deleteMany(),
    // Relation-free (see schema): nothing cascades it, so clear it explicitly
    // or stored chat attachments bleed into the next spec file.
    prisma.assistantAttachment.deleteMany(),
    // Same for transcripts — the conversation is relation-free on userId so
    // that deleting a user can't destroy the record an admin is meant to keep.
    // Its messages DO cascade from the conversation.
    prisma.assistantConversation.deleteMany(),
  ]);
}

// Compute the fixture bcrypt hash once per worker instead of re-hashing the
// same literal password on every createTeacher/createStudent/createAdmin call.
export const TEST_PASSWORD_HASH = bcrypt.hashSync("Password1!", 4);

let seq = 0;
function uniq(prefix: string) {
  seq += 1;
  return `${prefix}-${seq}`;
}

export async function createTeacher(
  overrides: Partial<{ email: string; username: string }> = {},
) {
  const tag = uniq("teacher");
  const user = await prisma.user.create({
    data: {
      email: overrides.email ?? `${tag}@example.com`,
      username: overrides.username ?? tag,
      hashedPassword: TEST_PASSWORD_HASH,
      firstName: "Tess",
      lastName: "Teacher",
      role: "TEACHER",
      teacher: { create: {} },
    },
    include: { teacher: true },
  });
  return { user, teacher: user.teacher! };
}

export async function createStudent(
  overrides: Partial<{ email: string; username: string }> = {},
) {
  const tag = uniq("student");
  const user = await prisma.user.create({
    data: {
      email: overrides.email ?? `${tag}@example.com`,
      username: overrides.username ?? tag,
      hashedPassword: TEST_PASSWORD_HASH,
      firstName: "Stu",
      lastName: "Student",
      role: "STUDENT",
      student: { create: {} },
    },
    include: { student: true },
  });
  return { user, student: user.student! };
}

export async function createAdmin(
  overrides: Partial<{ email: string; username: string }> = {},
) {
  const tag = uniq("admin");
  return prisma.user.create({
    data: {
      email: overrides.email ?? `${tag}@example.com`,
      username: overrides.username ?? tag,
      hashedPassword: TEST_PASSWORD_HASH,
      firstName: "Ada",
      lastName: "Admin",
      role: "ADMIN",
    },
  });
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
  const {
    classId,
    teacherId,
    answerMode = "SINGLE_SELECT",
    published = true,
  } = opts;
  const topic = await prisma.topic.create({
    data: { name: uniq("topic"), teacherId: teacherId ?? null },
  });
  const quiz = await prisma.quiz.create({
    data: {
      name: uniq("quiz"),
      topicId: topic.id,
      teacherId: teacherId ?? null,
    },
  });
  await prisma.classQuiz.create({
    data: { classId, quizId: quiz.id, published },
  });

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
