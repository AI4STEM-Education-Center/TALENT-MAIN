import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasResearchConsent } from "@/lib/consent";
import { rateLimit } from "@/lib/rate-limit";
import { parseJsonBody, resourceSessionUpdateSchema } from "@/lib/validation";
import { mergeResourceTotals, parsePageDwell } from "@/lib/resource-telemetry";

export const runtime = "nodejs";

/** ~300 page entries at most, plus a few counters. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * PATCH /api/student/materials/[materialId]/sessions/[sessionId]
 * POST  (same handler — navigator.sendBeacon can only POST)
 *
 * Record a telemetry batch for an open reading session. The client reports
 * CUMULATIVE per-open totals; mergeResourceTotals takes max(stored, incoming)
 * per field so replays and the fetch/beacon race never double-count or move a
 * record backwards, then bounds dwell by the wall-clock time since the open
 * and active/per-page time by dwell. `ended` stamps endedAt once. Only the
 * student who opened the session may write to it.
 */
async function recordBatch(
  req: NextRequest,
  { params }: { params: Promise<{ materialId: string; sessionId: string }> },
) {
  const [session, { materialId, sessionId }] = await Promise.all([
    auth(),
    params,
  ]);
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "STUDENT") {
    return NextResponse.json(
      { error: "Only student sessions are recorded" },
      { status: 403 },
    );
  }

  // The client flushes every 15s plus on hide/close; several open tabs stay
  // comfortably under this.
  const limited = rateLimit(
    req,
    "resource-session-update",
    120,
    60_000,
    session.user.id,
  );
  if (limited) return limited;

  const parsed = await parseJsonBody(
    resourceSessionUpdateSchema,
    req,
    MAX_BODY_BYTES,
  );
  if (!parsed.ok) return parsed.response;

  // Consent may have changed since the session opened: a late batch must not
  // keep collecting after a decline or a new form version.
  if (!(await hasResearchConsent(session.user.id))) {
    return NextResponse.json({ ok: true });
  }

  const [student, row] = await Promise.all([
    prisma.student.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    }),
    prisma.learningResourceSession.findUnique({ where: { id: sessionId } }),
  ]);
  if (
    !student ||
    !row ||
    row.materialId !== materialId ||
    row.studentId !== student.id
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data } = parsed;
  const merged = mergeResourceTotals(
    {
      dwellMs: row.dwellMs,
      activeMs: row.activeMs,
      clickCount: row.clickCount,
      pdfOpenCount: row.pdfOpenCount,
      pages: parsePageDwell(row.pagesViewedJson),
    },
    {
      dwellMs: data.dwellMs,
      activeMs: data.activeMs,
      clickCount: data.clickCount,
      pdfOpenCount: data.pdfOpenCount,
      pages: data.pages,
    },
    Date.now() - row.openedAt.getTime(),
  );

  await prisma.learningResourceSession.update({
    where: { id: row.id },
    data: {
      dwellMs: merged.dwellMs,
      activeMs: merged.activeMs,
      clickCount: merged.clickCount,
      pdfOpenCount: merged.pdfOpenCount,
      pagesViewed: merged.pagesViewed,
      pagesViewedJson:
        merged.pagesViewed > 0 ? JSON.stringify(merged.pages) : null,
      ...(data.ended && !row.endedAt ? { endedAt: new Date() } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}

export const PATCH = recordBatch;
export const POST = recordBatch;
