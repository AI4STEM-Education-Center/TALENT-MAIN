import { NextRequest, NextResponse } from "next/server";
import { guardText } from "@/lib/guardrail-runner";
import { prisma } from "@/lib/prisma";
import {
  canManage,
  canRead,
  getContentActor,
  type ContentActor,
} from "@/lib/quiz-access";
import { parseJsonBody } from "@/lib/validation";
import {
  choiceValidationError,
  parseNumericAnswer,
  questionCreateSchema,
  questionUpdateSchema,
  questionDeleteSchema,
} from "@/lib/question-input";

const badRequest = (error: string) =>
  NextResponse.json({ error }, { status: 400 });

/** Edits and creates must pass the same authoring guardrail. */
async function checkAuthoredText(
  actor: ContentActor,
  quizId: string,
  text: string,
  options: { text: string }[],
) {
  const guard = await guardText(
    [text, ...options.map((option) => option.text)].filter(Boolean).join("\n"),
    { surface: "question_authoring", id: quizId, userId: actor.userId },
    { requestPath: true },
  );
  return guard.blocked
    ? NextResponse.json(
        { error: guard.message, guardrailEventId: guard.eventId },
        { status: 422 },
      )
    : null;
}

export async function GET(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const quizId = searchParams.get("quizId");
  const difficulty = searchParams.get("difficulty");
  if (!quizId)
    return NextResponse.json({ error: "quizId required" }, { status: 400 });

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
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseJsonBody(questionCreateSchema, req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const quiz = await prisma.quiz.findUnique({ where: { id: body.quizId } });
  if (!quiz || !canManage(actor, quiz))
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

  const answerMode = body.answerMode ?? "SINGLE_SELECT";
  const options = answerMode === "NUMERIC" ? [] : (body.options ?? []);
  const numeric = answerMode === "NUMERIC" ? parseNumericAnswer(body) : null;
  if (numeric && "error" in numeric) return badRequest(numeric.error);
  if (!numeric) {
    const error = choiceValidationError(answerMode, options);
    if (error) return badRequest(error);
  }
  const blocked = await checkAuthoredText(actor, quiz.id, body.text, options);
  if (blocked) return blocked;

  const question = await prisma.question.create({
    data: {
      text: body.text,
      quizId: quiz.id,
      difficultyLevel: body.difficultyLevel ?? "BEGINNER",
      answerMode,
      createdById: actor.teacherId,
      ...(numeric ?? {}),
      options: {
        create: options.map(({ text, isCorrect }) => ({ text, isCorrect })),
      },
    },
    include: { options: true, quiz: true },
  });
  return NextResponse.json(question, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseJsonBody(questionUpdateSchema, req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const existing = await prisma.question.findUnique({
    where: { id: body.id },
    include: { quiz: true, options: true },
  });
  if (!existing || !canManage(actor, existing.quiz))
    return NextResponse.json({ error: "Question not found" }, { status: 404 });

  const answerMode = body.answerMode ?? existing.answerMode;
  const priorById = new Map(
    existing.options.map((option) => [option.id, option]),
  );
  const options =
    answerMode === "NUMERIC"
      ? []
      : (body.options ?? existing.options).map((option) => ({
          ...option,
          imageStorageKey: option.id
            ? priorById.get(option.id)?.imageStorageKey
            : null,
        }));
  const numeric =
    answerMode === "NUMERIC"
      ? parseNumericAnswer({ ...existing, ...body })
      : null;
  if (numeric && "error" in numeric) return badRequest(numeric.error);
  if (!numeric) {
    const error = choiceValidationError(answerMode, options);
    if (error) return badRequest(error);
  }
  const blocked = await checkAuthoredText(
    actor,
    existing.quizId,
    body.text ?? existing.text,
    options,
  );
  if (blocked) return blocked;

  // Keep unchanged option ids so student answers and stored image crops retain
  // their references. Every option mutation and the question write commit together.
  const updated = await prisma.$transaction(async (tx) => {
    await tx.question.update({
      where: { id: existing.id },
      data: {
        text: body.text,
        difficultyLevel: body.difficultyLevel,
        answerMode,
        ...(numeric ?? {
          answerNumeric: null,
          answerTolerance: null,
          answerUnit: null,
        }),
      },
    });
    if (answerMode === "NUMERIC" || body.options !== undefined) {
      const retainedIds = options.flatMap((option) =>
        option.id && priorById.has(option.id) ? [option.id] : [],
      );
      await tx.option.deleteMany({
        where: { questionId: existing.id, id: { notIn: retainedIds } },
      });
      for (const option of options) {
        const data = { text: option.text, isCorrect: option.isCorrect };
        if (option.id && priorById.has(option.id))
          await tx.option.update({ where: { id: option.id }, data });
        else
          await tx.option.create({
            data: { ...data, questionId: existing.id },
          });
      }
    }
    return tx.question.findUnique({
      where: { id: existing.id },
      include: { options: true },
    });
  });
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = await parseJsonBody(questionDeleteSchema, req);
  if (!parsed.ok) return parsed.response;
  const { id } = parsed.data;
  const existing = await prisma.question.findUnique({
    where: { id },
    include: { quiz: true },
  });
  if (!existing || !canManage(actor, existing.quiz))
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  await prisma.question.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
