import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST: Start a quiz attempt
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });

  const { classId, subtopicId } = await req.json();
  if (!classId || !subtopicId) {
    return NextResponse.json({ error: "classId and subtopicId required" }, { status: 400 });
  }

  // Verify student is enrolled
  const enrollment = await prisma.classEnrollment.findUnique({
    where: { classId_studentId: { classId, studentId: student.id } },
  });
  if (!enrollment) return NextResponse.json({ error: "Not enrolled in this class" }, { status: 403 });

  // Verify topic is published for this class
  const subtopic = await prisma.subtopic.findUnique({ where: { id: subtopicId }, include: { topic: true } });
  if (!subtopic) return NextResponse.json({ error: "Subtopic not found" }, { status: 404 });

  const classTopic = await prisma.classTopic.findUnique({
    where: { classId_topicId: { classId, topicId: subtopic.topicId } },
  });
  if (!classTopic?.published) {
    return NextResponse.json({ error: "This module is not yet available." }, { status: 403 });
  }

  // Get questions for this subtopic
  const questions = await prisma.question.findMany({
    where: { subtopicId },
    include: { options: { select: { id: true, text: true } } }, // don't expose isCorrect
    orderBy: { createdAt: "asc" },
  });

  if (questions.length === 0) {
    return NextResponse.json({ error: "No questions available for this module." }, { status: 404 });
  }

  // Create attempt
  const attempt = await prisma.quizAttempt.create({
    data: { studentId: student.id, classId, subtopicId },
  });

  // Update ModuleProgress to IN_PROGRESS
  await prisma.moduleProgress.upsert({
    where: { studentId_classId_subtopicId: { studentId: student.id, classId, subtopicId } },
    update: { status: "IN_PROGRESS" },
    create: { studentId: student.id, classId, subtopicId, status: "IN_PROGRESS" },
  });

  return NextResponse.json({ attemptId: attempt.id, questions });
}

// PATCH: Submit quiz answers
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });

  const { attemptId, answers } = await req.json();
  // answers: [{ questionId, selectedOptionId }]
  if (!attemptId || !answers) {
    return NextResponse.json({ error: "attemptId and answers required" }, { status: 400 });
  }

  const attempt = await prisma.quizAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.studentId !== student.id) {
    return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
  }

  // Score the answers
  let correct = 0;
  const answerRecords = [];

  for (const ans of answers) {
    const option = ans.selectedOptionId
      ? await prisma.option.findUnique({ where: { id: ans.selectedOptionId } })
      : null;
    const isCorrect = option?.isCorrect ?? false;
    if (isCorrect) correct++;

    answerRecords.push({
      quizAttemptId: attemptId,
      questionId: ans.questionId,
      selectedOptionId: ans.selectedOptionId ?? null,
      isCorrect,
    });
  }

  await prisma.quizAnswer.createMany({ data: answerRecords });

  const score = answers.length > 0 ? (correct / answers.length) * 100 : 0;

  await prisma.quizAttempt.update({
    where: { id: attemptId },
    data: { score, completedAt: new Date() },
  });

  // Update ModuleProgress: COMPLETED + bestScore
  const existing = await prisma.moduleProgress.findUnique({
    where: { studentId_classId_subtopicId: { studentId: student.id, classId: attempt.classId, subtopicId: attempt.subtopicId } },
  });

  await prisma.moduleProgress.upsert({
    where: { studentId_classId_subtopicId: { studentId: student.id, classId: attempt.classId, subtopicId: attempt.subtopicId } },
    update: {
      status: "COMPLETED",
      bestScore: Math.max(score, existing?.bestScore ?? 0),
    },
    create: {
      studentId: student.id,
      classId: attempt.classId,
      subtopicId: attempt.subtopicId,
      status: "COMPLETED",
      bestScore: score,
    },
  });

  // Return results with correct answers
  const questionsWithAnswers = await prisma.question.findMany({
    where: { id: { in: answers.map((a: { questionId: string }) => a.questionId) } },
    include: { options: true },
  });

  return NextResponse.json({
    score,
    correct,
    total: answers.length,
    questions: questionsWithAnswers,
    answers: answerRecords,
  });
}
