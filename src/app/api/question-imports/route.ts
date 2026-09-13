import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { QuestionImportError, validateParsedQuestionBank } from "@/lib/question-import/qti";
import { rateLimit } from "@/lib/rate-limit";
import { guardText } from "@/lib/guardrail-runner";
import { BODY_TOO_LARGE, readBoundedText } from "@/lib/request-body";

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

  // Bound the body as it streams in. Measuring after `req.text()` would be too
  // late: a request without content-length (chunked encoding) buffers in full
  // before any check runs, so the cap is enforced during the read instead.
  const raw = await readBoundedText(req, MAX_IMPORT_BYTES);
  if (raw === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Import payload is too large." }, { status: 413 });
  }

  let payload: unknown;
  try {
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

  // A QTI bank is an uploaded file's contents arriving as JSON, so it is
  // checked like any other imported document before it becomes Question rows.
  // Fails open; off-topic stays off (a question bank IS the topic).
  const importedText = parsed.questions
    .map((q) => [q.text, ...(q.options ?? []).map((o) => o.text)].filter(Boolean).join("\n"))
    .join("\n");
  const guard = await guardText(
    importedText,
    { surface: "question_import", id: quizId, userId: actor.userId },
    { requestPath: true }
  );
  if (guard.blocked) {
    // The id lets the client offer "report a problem" on the refusal. The
    // message stays vague about WHY on purpose; the reasons are admin-only.
    return NextResponse.json(
      { error: guard.message, guardrailEventId: guard.eventId },
      { status: 422 }
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
