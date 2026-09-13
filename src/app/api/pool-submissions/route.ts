import { NextRequest, NextResponse } from "next/server";
import { getContentActor } from "@/lib/quiz-access";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";

function applicationOrigin(req: NextRequest): string {
  const configured =
    process.env.APP_URL || process.env.AUTH_URL || process.env.NEXTAUTH_URL;
  if (configured) return configured.replace(/\/$/, "");
  const requestUrl = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const protocol =
    req.headers.get("x-forwarded-proto") ||
    requestUrl.protocol.replace(":", "");
  return host ? `${protocol}://${host}` : requestUrl.origin;
}

export async function GET() {
  const actor = await getContentActor();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (actor.role === "ADMIN") {
    const submissions = await prisma.poolSubmission.findMany({
      where: { reviewerId: actor.userId },
      include: {
        teacher: {
          select: {
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
        reviewer: { select: { firstName: true, lastName: true, email: true } },
        quiz: {
          select: {
            id: true,
            name: true,
            _count: { select: { questions: true } },
          },
        },
        material: {
          select: {
            id: true,
            title: true,
            originalName: true,
            totalPages: true,
          },
        },
        topic: { select: { id: true, name: true } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
    return NextResponse.json({ submissions });
  }

  const [admins, topics, submissions] = await Promise.all([
    prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.topic.findMany({
      where: { teacherId: null },
      select: { id: true, name: true, contentType: true },
      orderBy: [{ order: "asc" }, { name: "asc" }],
    }),
    prisma.poolSubmission.findMany({
      where: { teacherId: actor.teacherId },
      select: {
        id: true,
        contentType: true,
        status: true,
        quizId: true,
        materialId: true,
        decisionNote: true,
        emailStatus: true,
        createdAt: true,
        reviewer: { select: { firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return NextResponse.json({ admins, topics, submissions });
}

export async function POST(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor || actor.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    contentType?: unknown;
    contentId?: unknown;
    reviewerId?: unknown;
    topicId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contentType =
    body.contentType === "QUIZ" || body.contentType === "MATERIAL"
      ? body.contentType
      : null;
  const contentId = typeof body.contentId === "string" ? body.contentId : "";
  const reviewerId = typeof body.reviewerId === "string" ? body.reviewerId : "";
  const topicId =
    typeof body.topicId === "string" && body.topicId ? body.topicId : null;
  if (!contentType || !contentId || !reviewerId) {
    return NextResponse.json(
      { error: "Content and an administrator are required." },
      { status: 400 },
    );
  }

  const [reviewer, topic, teacher] = await Promise.all([
    prisma.user.findFirst({ where: { id: reviewerId, role: "ADMIN" } }),
    topicId
      ? prisma.topic.findFirst({
          where: { id: topicId, teacherId: null, contentType },
        })
      : null,
    prisma.teacher.findUnique({
      where: { id: actor.teacherId },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    }),
  ]);
  if (!reviewer)
    return NextResponse.json(
      { error: "Administrator not found." },
      { status: 404 },
    );
  if (topicId && !topic)
    return NextResponse.json(
      { error: "Global topic not found." },
      { status: 404 },
    );
  if (!teacher)
    return NextResponse.json({ error: "Teacher not found." }, { status: 404 });

  let contentName: string;
  if (contentType === "QUIZ") {
    const quiz = await prisma.quiz.findFirst({
      where: { id: contentId, teacherId: actor.teacherId },
    });
    if (!quiz)
      return NextResponse.json({ error: "Quiz not found." }, { status: 404 });
    contentName = quiz.name;
  } else {
    const material = await prisma.learningMaterial.findFirst({
      where: {
        id: contentId,
        teacherId: actor.teacherId,
        uploadStatus: "READY",
        processingStatus: "SUCCESS",
      },
    });
    if (!material) {
      return NextResponse.json(
        { error: "Only fully processed learning materials can be submitted." },
        { status: 404 },
      );
    }
    contentName = material.title || material.originalName;
  }

  const duplicate = await prisma.poolSubmission.findFirst({
    where: {
      teacherId: actor.teacherId,
      status: "PENDING",
      ...(contentType === "QUIZ"
        ? { quizId: contentId }
        : { materialId: contentId }),
    },
  });
  if (duplicate) {
    return NextResponse.json(
      { error: "This item already has a pending review request." },
      { status: 409 },
    );
  }

  const submission = await prisma.poolSubmission.create({
    data: {
      contentType,
      teacherId: actor.teacherId,
      reviewerId,
      topicId,
      ...(contentType === "QUIZ"
        ? { quizId: contentId }
        : { materialId: contentId }),
    },
  });

  const reviewUrl = `${applicationOrigin(req)}/admin/pool-submissions?request=${submission.id}`;
  let emailWarning: string | null = null;
  try {
    const result = await sendEmail({
      to: [reviewer.email],
      replyTo: teacher.user.email,
      subject: `Global pool approval requested: ${contentName}`,
      text: [
        `${teacher.user.firstName} ${teacher.user.lastName} has submitted a ${contentType === "QUIZ" ? "quiz" : "learning material"} for the AI4Talent global pool.`,
        "",
        `Title: ${contentName}`,
        `Requested topic: ${topic?.name ?? "Match the item's current topic / No topic"}`,
        "",
        `Review and approve or reject the request: ${reviewUrl}`,
      ].join("\n"),
    });
    if (result.failed > 0)
      throw new Error(result.errors.join("; ") || "Email delivery failed");
    await prisma.poolSubmission.update({
      where: { id: submission.id },
      data: { emailStatus: "SENT", emailError: null },
    });
  } catch (error) {
    emailWarning =
      error instanceof Error ? error.message : "Email delivery failed";
    await prisma.poolSubmission.update({
      where: { id: submission.id },
      data: { emailStatus: "FAILED", emailError: emailWarning },
    });
  }

  return NextResponse.json({ ...submission, emailWarning }, { status: 201 });
}
