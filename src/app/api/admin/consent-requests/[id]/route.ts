import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueConsentExportReadyEmail } from "@/lib/consent-email";
import { enqueueConsentEmails } from "@/lib/queue";

export const runtime = "nodejs";

/**
 * PATCH /api/admin/consent-requests/:id
 * Approve or reject a teacher's signed-students export request.
 *
 * Per the product decision on record (docs/plans/consent-compliance-plan.md
 * §7), there is NO automated "has this course ended" check. Approval instead
 * REQUIRES `courseEndedAttested: true` in the body — a mandatory, on-record
 * confirmation quoting the student consent form's own promise that
 * participation "will not be known to your course instructor while you are
 * enrolled" and that instructor access shouldn't happen "before your final
 * grades ... have been submitted." The admin UI disables its Approve button
 * until this checkbox is checked; this route re-enforces it server-side so
 * that requirement can't be bypassed by calling the API directly.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let body: { decision?: unknown; note?: unknown; courseEndedAttested?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const decision = body.decision === "APPROVE" || body.decision === "REJECT" ? body.decision : null;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
  if (!decision) return NextResponse.json({ error: "A valid decision is required." }, { status: 400 });

  const request = await prisma.consentExportRequest.findFirst({
    where: { id, reviewerId: session.user.id },
    include: { class: { select: { name: true } } },
  });
  if (!request) return NextResponse.json({ error: "Request not found." }, { status: 404 });
  if (request.status !== "PENDING") {
    return NextResponse.json({ error: "This request has already been decided." }, { status: 409 });
  }

  if (decision === "REJECT") {
    const rejected = await prisma.consentExportRequest.update({
      where: { id },
      data: { status: "REJECTED", decisionNote: note || null, decidedAt: new Date() },
    });
    return NextResponse.json({ request: rejected });
  }

  if (body.courseEndedAttested !== true) {
    return NextResponse.json(
      {
        error:
          "You must confirm the course has ended and final grades have been submitted before approving this export.",
      },
      { status: 400 }
    );
  }

  const [approved, teacher] = await Promise.all([
    prisma.consentExportRequest.update({
      where: { id },
      data: {
        status: "APPROVED",
        courseEndedAttested: true,
        decisionNote: note || null,
        decidedAt: new Date(),
      },
    }),
    prisma.teacher.findUnique({
      where: { id: request.teacherId },
      select: { user: { select: { email: true } } },
    }),
  ]);
  if (teacher?.user.email) {
    try {
      const deliveryId = await enqueueConsentExportReadyEmail(request.id, teacher.user.email);
      enqueueConsentEmails([deliveryId]);
    } catch (error) {
      console.error("[ConsentRequests] Failed to enqueue teacher delivery email:", error);
      await prisma.consentExportRequest.update({
        where: { id },
        data: {
          emailStatus: "FAILED",
          emailError: error instanceof Error ? error.message.slice(0, 300) : "Could not queue delivery",
        },
      });
    }
  }

  return NextResponse.json({ request: approved });
}
