import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { mapStagedToQuestionData, validateCommitQuestions } from "@/lib/quiz-extraction";
import { headS3Object, quizExtractionPrefix } from "@/lib/storage";

export const runtime = "nodejs";

// POST: commit the teacher-reviewed staged questions into real Question rows.
// Mirrors the QTI question-import transaction (QuestionImport + Question/Option
// creation, dedupe within the quiz) so PDF-extracted questions share the same
// provenance system. Guarded by status === AWAITING_REVIEW (409) to block a
// double commit. Figure keys are verified to be in-bounds + present in S3.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; extractionId: string }> }
) {
  const [actor, { id: quizId, extractionId }] = await Promise.all([getContentActor(), params]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const extraction = await prisma.quizPdfExtraction.findUnique({ where: { id: extractionId } });
  if (!extraction || extraction.quizId !== quizId) {
    return NextResponse.json({ error: "Extraction not found" }, { status: 404 });
  }

  // 409 (not 400) because the resource is in the wrong STATE — most importantly
  // this blocks committing a second time (status would be COMMITTED).
  if (extraction.status !== "AWAITING_REVIEW") {
    return NextResponse.json(
      { error: "Extraction is not awaiting review" },
      { status: 409 }
    );
  }

  let body: { questions?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let questions;
  try {
    questions = validateCommitQuestions(body.questions);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid commit payload" },
      { status: 400 }
    );
  }

  // SECURITY: every figure / image-choice key must live under THIS extraction's
  // figures/ prefix — otherwise a caller could attach an arbitrary S3 object
  // (e.g. another teacher's upload) to a question or option. Then confirm each
  // crop actually exists. Option images share the figures/ prefix on purpose, so
  // this one check covers both.
  const figurePrefix = `${quizExtractionPrefix(extraction.storageKey)}figures/`;
  const figureKeys: string[] = [];
  for (let qi = 0; qi < questions.length; qi += 1) {
    const q = questions[qi];
    if (q.hasFigure) {
      const key = q.figureStorageKey ?? "";
      if (!key.startsWith(figurePrefix)) {
        return NextResponse.json(
          { error: "figure storage key does not belong to this extraction" },
          { status: 400 }
        );
      }
      figureKeys.push(key);
    }
    for (let oi = 0; oi < q.options.length; oi += 1) {
      const o = q.options[oi];
      if (o.isImage !== true) continue;
      const key = o.imageStorageKey ?? "";
      if (!key.startsWith(figurePrefix)) {
        return NextResponse.json(
          { error: `question ${qi + 1} option ${oi + 1} image key does not belong to this extraction` },
          { status: 400 }
        );
      }
      figureKeys.push(key);
    }
  }

  try {
    await Promise.all(figureKeys.map((key) => headS3Object(extraction.bucket, key)));
  } catch {
    return NextResponse.json({ error: "figure upload incomplete" }, { status: 400 });
  }

  const result = await prisma.$transaction(async (tx) => {
    const questionImport = await tx.questionImport.create({
      data: {
        teacherId: extraction.teacherId,
        quizId,
        originalName: extraction.originalName,
        sourcePath: `pdf-extraction:${extraction.id}`,
        status: "COMPLETED",
        importedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        errors: "[]",
      },
    });

    let importedCount = 0;
    let skippedCount = 0;

    for (const question of questions) {
      // Dedupe by exact text within the quiz — an identical-text question
      // already in this quiz is treated as already-imported and skipped.
      const duplicate = await tx.question.findFirst({
        where: { quizId, text: question.text },
      });
      if (duplicate) {
        skippedCount += 1;
        continue;
      }

      await tx.question.create({
        data: mapStagedToQuestionData(question, {
          quizId,
          importId: questionImport.id,
          createdById: extraction.teacherId,
          figureBucket: extraction.bucket,
        }),
      });
      importedCount += 1;
    }

    await tx.questionImport.update({
      where: { id: questionImport.id },
      data: { importedCount, skippedCount },
    });

    await tx.quizPdfExtraction.update({
      where: { id: extraction.id },
      data: { status: "COMMITTED", questionImportId: questionImport.id },
    });

    return { importId: questionImport.id, importedCount, skippedCount };
  });

  return NextResponse.json({
    importId: result.importId,
    importedCount: result.importedCount,
    skippedCount: result.skippedCount,
    errorCount: 0,
    errors: [],
  });
}
