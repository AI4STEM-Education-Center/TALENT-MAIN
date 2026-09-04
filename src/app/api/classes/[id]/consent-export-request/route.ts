import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueConsentExportRequestEmail } from "@/lib/consent-email";
import { enqueueConsentEmails } from "@/lib/queue";
import { getSenderOverride } from "@/lib/email";
import { APP_NAME, renderPurposeMessage } from "@/lib/email-purposes";

export const runtime = "nodejs";

async function getTeacherClass(userId: string, classId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { userId } });
  if (!teacher) return null;
  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });
  return cls ? { teacher, cls } : null;
}

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

/**
 * GET /api/classes/[id]/consent-export-request
 * The list of admins a teacher may route a request to, plus their own past
 * requests for this class (with status, never with any per-student consent
 * detail — see docs/plans/consent-compliance-plan.md §6).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const owned = await getTeacherClass(session.user.id, id);
  if (!owned)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const [admins, requests] = await Promise.all([
    prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.consentExportRequest.findMany({
      where: { classId: id, teacherId: owned.teacher.id },
      select: {
        id: true,
        gradeColumnName: true,
        pointsAwarded: true,
        status: true,
        decisionNote: true,
        requestedAt: true,
        deliveredAt: true,
        reviewer: { select: { firstName: true, lastName: true } },
      },
      orderBy: { requestedAt: "desc" },
    }),
  ]);

  return NextResponse.json({ admins, requests });
}

/**
 * POST /api/classes/[id]/consent-export-request
 * Creates a pending request for the "which students signed the consent form"
 * export, formatted like an eLC grade column so it can be imported directly
 * — this never discloses individual decision data to the teacher, only an
 * aggregate credit-points outcome, and only once an admin approves it (§7).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const owned = await getTeacherClass(session.user.id, id);
  if (!owned)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  let body: {
    gradeColumnName?: unknown;
    pointsAwarded?: unknown;
    reviewerId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const gradeColumnName =
    typeof body.gradeColumnName === "string" ? body.gradeColumnName.trim() : "";
  const pointsAwarded = Number(body.pointsAwarded);
  const reviewerId = typeof body.reviewerId === "string" ? body.reviewerId : "";

  if (!gradeColumnName || gradeColumnName.length > 200) {
    return NextResponse.json(
      { error: "A grade column name (1-200 characters) is required." },
      { status: 400 },
    );
  }
  if (
    !Number.isFinite(pointsAwarded) ||
    pointsAwarded <= 0 ||
    pointsAwarded > 1_000_000
  ) {
    return NextResponse.json(
      { error: "Points awarded must be a number greater than 0." },
      { status: 400 },
    );
  }
  if (!reviewerId)
    return NextResponse.json(
      { error: "Choose an administrator to review this request." },
      { status: 400 },
    );

  const [reviewer, teacherUser] = await Promise.all([
    prisma.user.findFirst({ where: { id: reviewerId, role: "ADMIN" } }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { firstName: true, lastName: true, email: true },
    }),
  ]);
  if (!reviewer)
    return NextResponse.json(
      { error: "Administrator not found." },
      { status: 404 },
    );

  const pending = await prisma.consentExportRequest.findFirst({
    where: { classId: id, teacherId: owned.teacher.id, status: "PENDING" },
  });
  if (pending) {
    return NextResponse.json(
      { error: "This class already has a pending export request." },
      { status: 409 },
    );
  }

  const request = await prisma.consentExportRequest.create({
    data: {
      teacherId: owned.teacher.id,
      classId: id,
      gradeColumnName,
      pointsAwarded,
      reviewerId,
    },
  });

  const reviewUrl = `${applicationOrigin(req)}/admin/consent-requests?request=${request.id}`;
  try {
    const teacherName =
      `${teacherUser?.firstName ?? "A teacher"} ${teacherUser?.lastName ?? ""}`.trim() ||
      "A teacher";
    const override = await getSenderOverride("CONSENT_EXPORT_REQUEST").catch(
      () => null,
    );
    const { subject, text } = renderPurposeMessage(
      "CONSENT_EXPORT_REQUEST",
      {
        appName: APP_NAME,
        teacherName,
        className: owned.cls.name,
        gradeColumnName,
        pointsAwarded,
        reviewUrl,
      },
      override,
    );
    const deliveryId = await enqueueConsentExportRequestEmail({
      recipient: reviewer.email,
      replyTo: teacherUser?.email,
      subject,
      text,
    });
    enqueueConsentEmails([deliveryId]);
  } catch (error) {
    console.error(
      "[ConsentExportRequest] Failed to enqueue admin notification:",
      error,
    );
  }

  return NextResponse.json({ request }, { status: 201 });
}
