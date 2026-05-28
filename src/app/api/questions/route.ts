import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const topicId = searchParams.get("topicId");
  const subtopicId = searchParams.get("subtopicId");
  const difficulty = searchParams.get("difficulty");

  const where: Record<string, string> = {};
  if (topicId) where.topicId = topicId;
  if (subtopicId) where.subtopicId = subtopicId;
  if (difficulty) where.difficultyLevel = difficulty;

  const questions = await prisma.question.findMany({
    where,
    include: {
      options: true,
      topic: true,
      subtopic: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(questions);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const { text, topicId, subtopicId, difficultyLevel, options } = await req.json();

  if (!text?.trim() || !topicId || !subtopicId) {
    return NextResponse.json({ error: "text, topicId, and subtopicId are required." }, { status: 400 });
  }
  if (!options || options.length < 2) {
    return NextResponse.json({ error: "At least 2 options are required." }, { status: 400 });
  }
  if (!options.some((o: { isCorrect: boolean }) => o.isCorrect)) {
    return NextResponse.json({ error: "At least one option must be marked as correct." }, { status: 400 });
  }

  const question = await prisma.question.create({
    data: {
      text: text.trim(),
      topicId,
      subtopicId,
      difficultyLevel: difficultyLevel || "BEGINNER",
      createdById: teacher?.id,
      options: { create: options.map((o: { text: string; isCorrect: boolean }) => ({ text: o.text.trim(), isCorrect: o.isCorrect })) },
    },
    include: { options: true, topic: true, subtopic: true },
  });
  return NextResponse.json(question, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, text, difficultyLevel, options } = await req.json();
  if (!id) return NextResponse.json({ error: "Question id required." }, { status: 400 });

  const question = await prisma.question.update({
    where: { id },
    data: {
      text: text?.trim(),
      difficultyLevel,
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
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  await prisma.question.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
