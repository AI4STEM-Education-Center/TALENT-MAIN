import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { QuestionImportError, validateParsedQuestionBank } from "@/lib/question-import/qti";

export const runtime = "nodejs";

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function serializeErrors(errors: QuestionImportError[]) {
  return errors.map((error) => ({
    index: error.index,
    ...(error.sourceQuestionId ? { sourceQuestionId: error.sourceQuestionId } : {}),
    message: error.message,
  }));
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON import payload." }, { status: 400 });
  }

  const importPayload = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const topicId = cleanString(importPayload.topicId);
  const subtopicId = cleanString(importPayload.subtopicId);
  const originalName = cleanString(importPayload.originalName);
  const sourcePath = cleanString(importPayload.sourcePath) || null;

  if (!topicId || !subtopicId) {
    return NextResponse.json({ error: "topicId and subtopicId are required." }, { status: 400 });
  }

  if (!originalName) {
    return NextResponse.json({ error: "originalName is required." }, { status: 400 });
  }

  const subtopic = await prisma.subtopic.findUnique({ where: { id: subtopicId } });
  if (!subtopic || subtopic.topicId !== topicId) {
    return NextResponse.json({ error: "Selected module does not belong to the selected topic." }, { status: 400 });
  }

  let parsed;
  try {
    parsed = validateParsedQuestionBank(importPayload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid question import payload." },
      { status: 400 }
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const questionImport = await tx.questionImport.create({
      data: {
        teacherId: teacher.id,
        topicId,
        subtopicId,
        originalName,
        sourcePath,
        bankId: parsed.bankId,
        bankTitle: parsed.bankTitle,
        importedCount: 0,
        skippedCount: 0,
        errorCount: parsed.errors.length,
        errors: JSON.stringify(serializeErrors(parsed.errors)),
      },
    });

    let importedCount = 0;
    let skippedCount = 0;
    const errors: QuestionImportError[] = [...parsed.errors];

    for (const question of parsed.questions) {
      const duplicate = await tx.question.findFirst({
        where: {
          topicId,
          subtopicId,
          createdById: teacher.id,
          ...(question.sourceQuestionId ? { sourceQuestionId: question.sourceQuestionId } : { text: question.text }),
          import: {
            is: {
              teacherId: teacher.id,
              originalName,
              sourcePath,
            },
          },
        },
      });

      if (duplicate) {
        skippedCount += 1;
        continue;
      }

      await tx.question.create({
        data: {
          title: question.title,
          text: question.text,
          topicId,
          subtopicId,
          difficultyLevel: "BEGINNER",
          answerMode: question.answerMode,
          points: question.points,
          feedbackGeneral: question.feedbackGeneral,
          feedbackCorrect: question.feedbackCorrect,
          feedbackIncorrect: question.feedbackIncorrect,
          sourceQuestionId: question.sourceQuestionId,
          importId: questionImport.id,
          createdById: teacher.id,
          options: {
            create: question.options,
          },
        },
      });
      importedCount += 1;
    }

    const status = importedCount > 0 || skippedCount > 0 ? "COMPLETED" : "FAILED";
    await tx.questionImport.update({
      where: { id: questionImport.id },
      data: {
        status,
        importedCount,
        skippedCount,
        errorCount: errors.length,
        errors: JSON.stringify(serializeErrors(errors)),
      },
    });

    return {
      importId: questionImport.id,
      status,
      bankId: parsed.bankId,
      bankTitle: parsed.bankTitle,
      importedCount,
      skippedCount,
      errorCount: errors.length,
      errors,
    };
  });

  return NextResponse.json(result, { status: 201 });
}
