import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import {
  mapStagedToQuestionData,
  validateCommitQuestions,
} from "@/lib/quiz-extraction";
import {
  deleteS3Objects,
  headS3Object,
  listS3Objects,
  quizExtractionPrefix,
} from "@/lib/storage";

export const runtime = "nodejs";

// POST: commit the teacher-reviewed staged questions into real Question rows.
// Mirrors the QTI question-import transaction (QuestionImport + Question/Option
// creation, dedupe within the quiz) so PDF-extracted questions share the same
// provenance system. Guarded by status === AWAITING_REVIEW (409) to block a
// double commit. Figure keys are verified to be in-bounds + present in S3.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; extractionId: string }> },
) {
  const [actor, { id: quizId, extractionId }] = await Promise.all([
    getContentActor(),
    params,
  ]);
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const extraction = await prisma.quizPdfExtraction.findUnique({
    where: { id: extractionId },
  });
  if (!extraction || extraction.quizId !== quizId) {
    return NextResponse.json(
      { error: "Extraction not found" },
      { status: 404 },
    );
  }

  // 409 (not 400) because the resource is in the wrong STATE — most importantly
  // this blocks committing a second time (status would be COMMITTED).
  if (extraction.status !== "AWAITING_REVIEW") {
    return NextResponse.json(
      { error: "Extraction is not awaiting review" },
      { status: 409 },
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
      { status: 400 },
    );
  }

  // SECURITY: every figure / image-choice key must be one THIS extraction handed
  // out a presigned PUT for. A "lives under the figures/ prefix" test is weaker
  // than it looks — it accepts any object under the folder, so it cannot tell an
  // issued crop from one the extraction never issued. Matching against the
  // recorded set is exact. Option images share the figures/ prefix on purpose,
  // so one lookup covers both.
  //
  // NOT bound to the question/option index the key was issued for, deliberately:
  // the review UI lets a teacher delete a staged question, which reindexes every
  // question after it, and a commit retried after a mid-flight failure reuses
  // crops uploaded under the old indexes. Slot-binding would reject those
  // legitimate flows while adding nothing — every key in this set is already
  // confined to this extraction, and the teacher authors the payload anyway.
  const figurePrefix = `${quizExtractionPrefix(extraction.storageKey)}figures/`;
  const issuedFigures = await prisma.quizPdfExtractionFigure.findMany({
    where: { extractionId: extraction.id },
    select: { storageKey: true },
  });
  const issuedKeys = new Set(issuedFigures.map((f) => f.storageKey));
  const figureKeys: string[] = [];
  for (let qi = 0; qi < questions.length; qi += 1) {
    const q = questions[qi];
    if (q.hasFigure) {
      const key = q.figureStorageKey ?? "";
      if (!issuedKeys.has(key)) {
        return NextResponse.json(
          {
            error: `question ${qi + 1} figure was not uploaded for this extraction — re-crop it and try again`,
          },
          { status: 400 },
        );
      }
      figureKeys.push(key);
    }
    for (let oi = 0; oi < q.options.length; oi += 1) {
      const o = q.options[oi];
      if (o.isImage !== true) continue;
      const key = o.imageStorageKey ?? "";
      if (!issuedKeys.has(key)) {
        return NextResponse.json(
          {
            error: `question ${qi + 1} option ${oi + 1} image was not uploaded for this extraction — re-crop it and try again`,
          },
          { status: 400 },
        );
      }
      figureKeys.push(key);
    }
  }

  try {
    await Promise.all(
      figureKeys.map((key) => headS3Object(extraction.bucket, key)),
    );
  } catch {
    return NextResponse.json(
      { error: "figure upload incomplete" },
      { status: 400 },
    );
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

  // The extraction is committed — the source PDF and page rasters have served
  // their purpose, so delete them (plus their page rows) rather than keep them
  // forever. Committed figures/ objects stay: the just-created Question/Option
  // rows reference them in place. Issued-but-uncommitted crops do NOT — every
  // re-crop mints a fresh UUID key, so without this each retry would strand an
  // object under the one prefix the sweep otherwise preserves wholesale.
  // Best-effort — the worker's S3 GC sweeps whatever is left.
  const committedKeys = new Set(figureKeys);
  const orphanFigureKeys = new Set(
    issuedFigures
      .map((f) => f.storageKey)
      .filter((key) => !committedKeys.has(key)),
  );
  try {
    const prefix = quizExtractionPrefix(extraction.storageKey);
    const keys = (await listS3Objects(extraction.bucket, prefix)).filter(
      (key) => !key.startsWith(figurePrefix) || orphanFigureKeys.has(key),
    );
    if (keys.length > 0) await deleteS3Objects(extraction.bucket, keys);
    await prisma.quizPdfExtractionPage.deleteMany({
      where: { extractionId: extraction.id },
    });
    if (orphanFigureKeys.size > 0) {
      await prisma.quizPdfExtractionFigure.deleteMany({
        where: {
          extractionId: extraction.id,
          storageKey: { in: [...orphanFigureKeys] },
        },
      });
    }
  } catch (e) {
    console.error("Post-commit extraction cleanup failed:", e);
  }

  return NextResponse.json({
    importId: result.importId,
    importedCount: result.importedCount,
    skippedCount: result.skippedCount,
    errorCount: 0,
    errors: [],
  });
}
