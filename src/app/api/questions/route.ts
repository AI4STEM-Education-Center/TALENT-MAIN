import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, canRead, getContentActor } from "@/lib/quiz-access";

export async function GET(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const quizId = searchParams.get("quizId");
  const difficulty = searchParams.get("difficulty");
  if (!quizId) return NextResponse.json({ error: "quizId required" }, { status: 400 });

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || !canRead(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const questions = await prisma.question.findMany({
    where: { quizId, ...(difficulty && { difficultyLevel: difficulty }) },
    include: { options: true, quiz: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(questions);
}

export async function POST(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { text, quizId, difficultyLevel, answerMode, options } = await req.json();
  const normalizedAnswerMode = answerMode === "MULTI_SELECT" ? "MULTI_SELECT" : "SINGLE_SELECT";

  if (!text?.trim() || !quizId) {
    return NextResponse.json({ error: "text and quizId are required." }, { status: 400 });
  }
  if (!options || options.length < 2) {
    return NextResponse.json({ error: "At least 2 options are required." }, { status: 400 });
  }
  if (!options.some((o: { isCorrect: boolean }) => o.isCorrect)) {
    return NextResponse.json({ error: "At least one option must be marked as correct." }, { status: 400 });
  }
  if (normalizedAnswerMode === "SINGLE_SELECT" && options.filter((o: { isCorrect: boolean }) => o.isCorrect).length > 1) {
    return NextResponse.json({ error: "Single-select questions can only have one correct option." }, { status: 400 });
  }

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const question = await prisma.question.create({
    data: {
      text: text.trim(),
      quizId,
      difficultyLevel: difficultyLevel || "BEGINNER",
      answerMode: normalizedAnswerMode,
      createdById: actor.teacherId,
      options: { create: options.map((o: { text: string; isCorrect: boolean }) => ({ text: o.text.trim(), isCorrect: o.isCorrect })) },
    },
    include: { options: true, quiz: true },
  });
  return NextResponse.json(question, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, text, difficultyLevel, answerMode, options } = await req.json();
  if (!id) return NextResponse.json({ error: "Question id required." }, { status: 400 });
  const normalizedAnswerMode = answerMode === "MULTI_SELECT" ? "MULTI_SELECT" : answerMode === "SINGLE_SELECT" ? "SINGLE_SELECT" : undefined;

  if (options) {
    if (options.length < 2) {
      return NextResponse.json({ error: "At least 2 options are required." }, { status: 400 });
    }
    if (!options.some((o: { isCorrect: boolean }) => o.isCorrect)) {
      return NextResponse.json({ error: "At least one option must be marked as correct." }, { status: 400 });
    }
    if (normalizedAnswerMode === "SINGLE_SELECT" && options.filter((o: { isCorrect: boolean }) => o.isCorrect).length > 1) {
      return NextResponse.json({ error: "Single-select questions can only have one correct option." }, { status: 400 });
    }
  }

  const existing = await prisma.question.findUnique({ where: { id }, include: { quiz: true } });
  if (!existing || !canManage(actor, existing.quiz)) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  await prisma.question.update({
    where: { id },
    data: {
      text: text?.trim(),
      difficultyLevel,
      answerMode: normalizedAnswerMode,
    },
  });

  if (options) {
    // Delete existing options and re-create
    await prisma.option.deleteMany({ where: { questionId: id } });
    await prisma.option.createMany({
      data: options.map((o: { text: string; isCorrect: boolean }) => ({
        questionId: id,
        text: o.text.trim(),
        isCorrect: o.isCorrect,
      })),
    });
  }

  const updated = await prisma.question.findUnique({ where: { id }, include: { options: true } });
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json();
  const existing = await prisma.question.findUnique({ where: { id }, include: { quiz: true } });
  if (!existing || !canManage(actor, existing.quiz)) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  await prisma.question.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
