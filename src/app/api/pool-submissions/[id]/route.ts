import { NextRequest, NextResponse } from "next/server";
import { getContentActor, deepCopyQuiz } from "@/lib/quiz-access";
import { deepCopyLearningMaterial } from "@/lib/material-pool";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [actor, { id }] = await Promise.all([getContentActor(), params]);
  if (!actor || actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { decision?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const decision =
    body.decision === "APPROVE" || body.decision === "REJECT"
      ? body.decision
      : null;
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
  if (!decision)
    return NextResponse.json(
      { error: "A valid decision is required." },
      { status: 400 },
    );

  const submission = await prisma.poolSubmission.findFirst({
    where: { id, reviewerId: actor.userId },
    include: { quiz: true, material: true, topic: true },
  });
  if (!submission)
    return NextResponse.json(
      { error: "Submission not found." },
      { status: 404 },
    );
  if (submission.status !== "PENDING") {
    return NextResponse.json(
      { error: "This request has already been decided." },
      { status: 409 },
    );
  }

  if (decision === "REJECT") {
    const rejected = await prisma.poolSubmission.update({
      where: { id },
      data: {
        status: "REJECTED",
        decisionNote: note || null,
        decidedAt: new Date(),
      },
    });
    return NextResponse.json({ submission: rejected });
  }

  const claimed = await prisma.poolSubmission.updateMany({
    where: { id, reviewerId: actor.userId, status: "PENDING" },
    data: { status: "REVIEWING" },
  });
  if (claimed.count !== 1) {
    return NextResponse.json(
      { error: "This request is already being reviewed." },
      { status: 409 },
    );
  }

  try {
    const targetTopicId = submission.topicId ?? undefined;
    const copy =
      submission.contentType === "QUIZ"
        ? await deepCopyQuiz(submission.quizId!, null, targetTopicId)
        : await deepCopyLearningMaterial(submission.materialId!, {
            teacherId: null,
            classId: null,
            topicId: targetTopicId,
          });
    if (!copy) throw new Error("The submitted content no longer exists.");

    const approved = await prisma.poolSubmission.update({
      where: { id },
      data: {
        status: "APPROVED",
        decisionNote: note || null,
        decidedAt: new Date(),
      },
    });
    return NextResponse.json({ submission: approved, copy });
  } catch (error) {
    await prisma.poolSubmission.updateMany({
      where: { id, status: "REVIEWING" },
      data: { status: "PENDING" },
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approval failed." },
      { status: 500 },
    );
  }
}
