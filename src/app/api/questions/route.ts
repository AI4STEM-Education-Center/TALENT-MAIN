import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, canRead, getContentActor } from "@/lib/quiz-access";
import { normalizeNumericValue } from "@/lib/quiz-scoring";

/**
 * Validate and normalize the NUMERIC answer payload (answerNumeric required and
 * finite, answerTolerance optional but > 0 when given, answerUnit a trimmed
 * string or null). Returns either an error message or the persisted shape.
 */
function parseNumericPayload(body: {
  answerNumeric?: unknown;
  answerTolerance?: unknown;
  answerUnit?: unknown;
}): { error: string } | { answerNumeric: number; answerTolerance: number | null; answerUnit: string | null } {
  const answerNumeric = normalizeNumericValue(body.answerNumeric);
  if (answerNumeric === null) {
    return { error: "A finite numeric answer is required." };
  }
  let answerTolerance: number | null = null;
  if (body.answerTolerance !== undefined && body.answerTolerance !== null && body.answerTolerance !== "") {
    const tol = normalizeNumericValue(body.answerTolerance);
    if (tol === null || tol <= 0) {
      return { error: "Tolerance must be a positive number." };
    }
    answerTolerance = tol;
  }
  const answerUnit =
    typeof body.answerUnit === "string" && body.answerUnit.trim() ? body.answerUnit.trim() : null;
  return { answerNumeric, answerTolerance, answerUnit };
}

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

  const body = await req.json();
  const { text, quizId, difficultyLevel, answerMode, options } = body;
  const isNumeric = answerMode === "NUMERIC";
  const normalizedAnswerMode = isNumeric ? "NUMERIC" : answerMode === "MULTI_SELECT" ? "MULTI_SELECT" : "SINGLE_SELECT";

  if (!text?.trim() || !quizId) {
    return NextResponse.json({ error: "text and quizId are required." }, { status: 400 });
  }

  // NUMERIC questions carry no options; choice questions require valid options.
  let numeric: { answerNumeric: number; answerTolerance: number | null; answerUnit: string | null } | null = null;
  if (isNumeric) {
    const parsed = parseNumericPayload(body);
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    numeric = parsed;
  } else {
    if (!options || options.length < 2) {
      return NextResponse.json({ error: "At least 2 options are required." }, { status: 400 });
    }
    if (!options.some((o: { isCorrect: boolean }) => o.isCorrect)) {
      return NextResponse.json({ error: "At least one option must be marked as correct." }, { status: 400 });
    }
    if (normalizedAnswerMode === "SINGLE_SELECT" && options.filter((o: { isCorrect: boolean }) => o.isCorrect).length > 1) {
      return NextResponse.json({ error: "Single-select questions can only have one correct option." }, { status: 400 });
    }
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
      ...(numeric
        ? { answerNumeric: numeric.answerNumeric, answerTolerance: numeric.answerTolerance, answerUnit: numeric.answerUnit }
        : { options: { create: options.map((o: { text: string; isCorrect: boolean }) => ({ text: o.text.trim(), isCorrect: o.isCorrect })) } }),
    },
    include: { options: true, quiz: true },
  });
  return NextResponse.json(question, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { id, text, difficultyLevel, answerMode, options } = body;
  if (!id) return NextResponse.json({ error: "Question id required." }, { status: 400 });
  const isNumeric = answerMode === "NUMERIC";
  const normalizedAnswerMode =
    isNumeric ? "NUMERIC" : answerMode === "MULTI_SELECT" ? "MULTI_SELECT" : answerMode === "SINGLE_SELECT" ? "SINGLE_SELECT" : undefined;

  // NUMERIC: validate the numeric payload (and ignore options). Choice modes:
  // validate options when present, exactly as before.
  let numeric: { answerNumeric: number; answerTolerance: number | null; answerUnit: string | null } | null = null;
  if (isNumeric) {
    const parsed = parseNumericPayload(body);
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    numeric = parsed;
  } else if (options) {
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

  // Mode transitions: switching TO a choice mode nulls the numeric scalars;
  // switching TO NUMERIC writes them instead (and drops options below). Figure
  // fields are preserved and never settable through this route (figures
  // originate from the PDF pipeline).
  const switchingToChoice = normalizedAnswerMode !== undefined && !isNumeric;
  await prisma.question.update({
    where: { id },
    data: {
      text: text?.trim(),
      difficultyLevel,
      answerMode: normalizedAnswerMode,
      ...(isNumeric && numeric
        ? { answerNumeric: numeric.answerNumeric, answerTolerance: numeric.answerTolerance, answerUnit: numeric.answerUnit }
        : switchingToChoice
          ? { answerNumeric: null, answerTolerance: null, answerUnit: null }
          : {}),
    },
  });

  if (isNumeric) {
    // NUMERIC questions hold zero options; drop any left from a prior mode.
    await prisma.option.deleteMany({ where: { questionId: id } });
  } else if (options) {
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
