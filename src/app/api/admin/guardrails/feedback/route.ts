import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logApiError } from "@/lib/system-log";
import {
  isGuardrailFeedbackStatus,
  readReasons,
  GUARDRAIL_FEEDBACK_STATUSES,
} from "@/lib/guardrail-events";
import { GUARDRAIL_SURFACE_LABELS, isGuardrailSurface } from "@/lib/guardrail-settings";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

/**
 * GET /api/admin/guardrails/feedback?status=NEW
 *
 * The review queue behind the Guardrails panel: what users said, next to the
 * reasons they were never shown. This is the read that tells an admin whether a
 * check is ready to go from Report to Block — log rows say how OFTEN a check
 * fires, and only these say whether it was RIGHT.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = new URL(req.url).searchParams.get("status");

  try {
    const rows = await prisma.guardrailFeedback.findMany({
      where: isGuardrailFeedbackStatus(status) ? { status } : {},
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      include: {
        event: { select: { surface: true, subjectId: true, blocked: true, reasons: true } },
      },
    });

    // Names are resolved in one extra query rather than a join: userId carries
    // no FK (an event outlives the account), so Prisma cannot relate it.
    const userIds = [...new Set(rows.map((row) => row.userId).filter((id): id is string => !!id))];
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, firstName: true, lastName: true, email: true, role: true },
        })
      : [];
    const userById = new Map(users.map((user) => [user.id, user]));

    return NextResponse.json({
      statuses: GUARDRAIL_FEEDBACK_STATUSES,
      feedback: rows.map((row) => {
        const user = row.userId ? userById.get(row.userId) : undefined;
        return {
          id: row.id,
          createdAt: row.createdAt,
          message: row.message,
          status: row.status,
          reviewedAt: row.reviewedAt,
          surface: row.event.surface,
          surfaceLabel: isGuardrailSurface(row.event.surface)
            ? GUARDRAIL_SURFACE_LABELS[row.event.surface]
            : row.event.surface,
          subjectId: row.event.subjectId,
          blocked: row.event.blocked,
          reasons: readReasons(row.event.reasons),
          // Deleted accounts leave the report standing but nameless.
          user: user
            ? {
                name: `${user.firstName} ${user.lastName}`.trim(),
                email: user.email,
                role: user.role,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    logApiError("ADMIN_GUARDRAIL_FEEDBACK_GET", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/guardrails/feedback
 * Body: { id, status }
 *
 * Mark one report reviewed or dismissed, so the queue empties as it is worked.
 */
export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { id, status } = (body ?? {}) as { id?: unknown; status?: unknown };
  if (typeof id !== "string" || !id.trim()) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }
  if (!isGuardrailFeedbackStatus(status)) {
    return NextResponse.json(
      { error: `status must be one of: ${GUARDRAIL_FEEDBACK_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const updated = await prisma.guardrailFeedback.updateMany({
      where: { id: id.trim() },
      data: {
        status,
        // Reopening clears the review stamp, so the row does not claim to have
        // been reviewed by someone who only moved it back.
        reviewedAt: status === "NEW" ? null : new Date(),
        reviewedBy: status === "NEW" ? null : session.user.id,
      },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    logApiError("ADMIN_GUARDRAIL_FEEDBACK_PATCH", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
