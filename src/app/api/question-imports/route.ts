import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { QuestionImportError, validateParsedQuestionBank } from "@/lib/question-import/qti";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

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

// POST: import a parsed QTI question bank into a quiz. Teachers import into
// their own quizzes; admins import straight into global-pool quizzes.
export async function POST(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = rateLimit(req, "question-import", 30, 60_000, actor.userId);
  if (limited) return limited;

  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BYTES) {
    return NextResponse.json({ error: "Import payload is too large." }, { status: 413 });
  }

  let payload: unknown;
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES) {
      return NextResponse.json({ error: "Import payload is too large." }, { status: 413 });
    }
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON import payload." }, { status: 400 });
  }

  const importPayload = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const quizId = cleanString(importPayload.quizId);
  const originalName = cleanString(importPayload.originalName);
  const sourcePath = cleanString(importPayload.sourcePath) || null;

  if (originalName.length > 255 || (sourcePath?.length ?? 0) > 1000) {
    return NextResponse.json({ error: "Import file metadata is too long." }, { status: 400 });
  }

  if (!quizId) {
    return NextResponse.json({ error: "quizId is required." }, { status: 400 });
  }

  if (!originalName) {
    return NextResponse.json({ error: "originalName is required." }, { status: 400 });
  }

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
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
        teacherId: actor.teacherId,
        quizId,
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
          quizId,
          ...(question.sourceQuestionId ? { sourceQuestionId: question.sourceQuestionId } : { text: question.text }),
          import: {
            is: {
              teacherId: actor.teacherId,
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
          quizId,
          difficultyLevel: "BEGINNER",
          answerMode: question.answerMode,
          points: question.points,
          feedbackGeneral: question.feedbackGeneral,
          feedbackCorrect: question.feedbackCorrect,
          feedbackIncorrect: question.feedbackIncorrect,
          sourceQuestionId: question.sourceQuestionId,
          importId: questionImport.id,
          createdById: actor.teacherId,
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
