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
 * Conditional-write attempts (see the loop below). Every lost attempt means
 * another batch for this same session committed in between, and a session
 * only ever has a handful of batches in flight (one periodic + hide/close,
 * all rate-limited), so contention drains long before these run out. The
 * final batch gets a deeper budget: it is the one the client can least
 * afford to have rejected, since the page may be gone.
 */
const MAX_WRITE_ATTEMPTS = 10;
const MAX_FINAL_WRITE_ATTEMPTS = 30;

/** Small jittered backoff so racing writers stop colliding in lockstep. */
const backoff = (attempt: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, Math.random() * Math.min(5 * 2 ** attempt, 50)),
  );

const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * PATCH /api/student/materials/[materialId]/sessions/[sessionId]
 * POST  (same handler — navigator.sendBeacon can only POST)
 *
 * Record a telemetry batch for an open reading session. The client reports
 * CUMULATIVE per-open totals; mergeResourceTotals takes max(stored, incoming)
 * per field so replays and the fetch/beacon race never double-count or move a
 * record backwards, then bounds dwell by the wall-clock time since the open
 * and active/per-page time by dwell. `ended` stamps endedAt once. Writes are
 * conditional on a version column, so overlapping batches are serialized
 * rather than last-write-wins. Only the student who opened the session may
 * write to it.
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

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!student) return notFound();

  const { data } = parsed;
  // Read-merge-write under optimistic concurrency: the write only lands if
  // the row still has the version we merged against. When a concurrent batch
  // (typically the periodic fetch racing the close beacon) got there first,
  // re-read and merge again — the merge is a max, so retrying is always safe.
  const attempts = data.ended ? MAX_FINAL_WRITE_ATTEMPTS : MAX_WRITE_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await backoff(attempt);
    const row = await prisma.learningResourceSession.findUnique({
      where: { id: sessionId },
    });
    if (!row || row.materialId !== materialId || row.studentId !== student.id)
      return notFound();

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

    const { count } = await prisma.learningResourceSession.updateMany({
      where: { id: row.id, version: row.version },
      data: {
        dwellMs: merged.dwellMs,
        activeMs: merged.activeMs,
        clickCount: merged.clickCount,
        pdfOpenCount: merged.pdfOpenCount,
        pagesViewed: merged.pagesViewed,
        pagesViewedJson:
          merged.pagesViewed > 0 ? JSON.stringify(merged.pages) : null,
        version: { increment: 1 },
        ...(data.ended && !row.endedAt ? { endedAt: new Date() } : {}),
      },
    });
    if (count === 1) return NextResponse.json({ ok: true });
  }

  // Reaching this needs 10 (30 for a final batch) other batches for this one
  // session to commit while we retried — a flood, not a race the real client
  // produces. The client treats 409 as "not delivered" and resends its
  // cumulative totals (periodic: next tick; final: bounded retries).
  return NextResponse.json(
    { error: "Session busy, retry later" },
    { status: 409 },
  );
}

export const PATCH = recordBatch;
export const POST = recordBatch;
