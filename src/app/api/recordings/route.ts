import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasResearchConsent, parseDeviceType } from "@/lib/consent";
import {
  isResearchExempt,
  allClassesResearchExcluded,
} from "@/lib/research-exclusion";
import { rateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/validation";
import { logApiError } from "@/lib/system-log";
import {
  RECORDING_ID_PATTERN,
  RECORDING_MAX_BODY_BYTES,
  RECORDING_MAX_BYTES,
  RECORDING_MAX_BYTES_PER_STUDENT,
  RECORDING_MAX_CHUNKS,
  areasInEvents,
  REPLAY_AREAS,
  eventTimeRange,
  hasFullSnapshot,
} from "@/lib/session-recording";
import {
  decodeUploadedEvents,
  parseAreas,
} from "@/lib/session-recording-server";

export const runtime = "nodejs";

const uploadSchema = z.object({
  recordingId: z.string().regex(RECORDING_ID_PATTERN),
  seq: z
    .number()
    .int()
    .min(0)
    .max(RECORDING_MAX_CHUNKS - 1),
  startedAt: z
    .number()
    .int()
    .positive()
    .max(Date.UTC(2100, 0, 1)),
  entryPath: z.string().max(300),
  path: z.string().max(300).optional(),
  viewport: z.object({
    width: z.number().int().min(0).max(20_000),
    height: z.number().int().min(0).max(20_000),
  }),
  encoding: z.enum(["gzip", "json"]),
  data: z.string().min(1).max(RECORDING_MAX_BODY_BYTES),
  final: z.boolean().optional(),
});

/**
 * Why the client should stop sending to this recording:
 * - no_consent     research consent is not on file (or was withdrawn): stop
 *                  recording altogether for this page load
 * - recording_full this recording hit its size cap: finish it, start a new one
 * - quota          the student's total stored recordings hit the cap: stop
 * - restart        the recording's opening snapshot never arrived: start over
 */
type StopReason = "no_consent" | "recording_full" | "quota" | "restart";

const stop = (reason: StopReason) =>
  NextResponse.json({ ok: true, accepted: false, stop: reason });

/** Check before capturing anything; POST still checks current consent atomically. */
export async function GET() {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "STUDENT")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const allowed =
    !(await isResearchExempt(session.user.id, "STUDENT")) &&
    (await hasResearchConsent(session.user.id));
  return NextResponse.json(
    { allowed },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/**
 * POST /api/recordings
 * Append one batch of rrweb events to a student's session recording, creating
 * the recording on its first batch. Student-only — staff are never recorded —
 * and, like the other telemetry, gated on research consent
 * (docs/plans/consent-compliance-plan.md §9): without consent the batch is
 * discarded and the client is told to stop.
 *
 * Idempotent: (recordingId, seq) is unique, so a retried upload is
 * acknowledged without storing the events twice. A recording id that exists
 * but belongs to someone else is a 404, never a 403.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (session.user.role !== "STUDENT") {
      return NextResponse.json(
        { error: "Only student sessions are recorded" },
        { status: 403 },
      );
    }

    // The recorder uploads every ~5s; two open tabs stay well under this.
    const limited = rateLimit(
      req,
      "recording-upload",
      60,
      60_000,
      session.user.id,
    );
    if (limited) return limited;

    const parsed = await parseJsonBody(
      uploadSchema,
      req,
      RECORDING_MAX_BODY_BYTES + 4096,
    );
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    if (!(await hasResearchConsent(session.user.id))) {
      return stop("no_consent");
    }

    const student = await prisma.student.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!student) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const decoded = decodeUploadedEvents(body.encoding, body.data);
    if (!decoded) {
      return NextResponse.json({ error: "Invalid events." }, { status: 400 });
    }
    const { events, gzip } = decoded;
    const range = eventTimeRange(events);

    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 400);
    return await prisma.$transaction(async (tx) => {
      // Take SQLite's writer lock BEFORE reading consent, ownership or quotas.
      // This serializes uploads (including across processes) and consent writes,
      // avoiding stale reads and deferred read-to-write lock upgrades.
      await tx.student.update({
        where: { id: student.id },
        data: { id: student.id },
      });
      const enrollments = await tx.classEnrollment.findMany({
        where: { studentId: student.id },
        select: { class: { select: { researchExcluded: true } } },
      });
      if (
        allClassesResearchExcluded(
          "STUDENT",
          enrollments.map((e) => e.class),
        ) ||
        !(await hasResearchConsent(
          session.user.id,
          tx,
          Math.min(body.startedAt, range.first),
        ))
      )
        return stop("no_consent");

      const existing = await tx.sessionRecording.findUnique({
        where: { id: body.recordingId },
      });
      if (existing && existing.studentId !== student.id) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      // Check duplicates before quotas: a retry consumes no additional space.
      const duplicate = await tx.sessionRecordingChunk.findUnique({
        where: {
          recordingId_seq: { recordingId: body.recordingId, seq: body.seq },
        },
        select: { seq: true },
      });
      if (duplicate)
        return NextResponse.json({ ok: true, accepted: true, duplicate: true });
      if (!existing && (body.seq !== 0 || !hasFullSnapshot(events)))
        return stop("restart");
      if (
        (existing?.byteCount ?? 0) + gzip.length > RECORDING_MAX_BYTES ||
        (existing?.chunkCount ?? 0) >= RECORDING_MAX_CHUNKS
      )
        return stop("recording_full");
      const stored = await tx.sessionRecording.aggregate({
        where: { studentId: student.id },
        _sum: { byteCount: true },
      });
      if (
        (stored._sum.byteCount ?? 0) + gzip.length >
        RECORDING_MAX_BYTES_PER_STUDENT
      )
        return stop("quota");
      const batchAreas = areasInEvents(
        events,
        body.path ?? (!existing ? body.entryPath : undefined),
      );
      const storedAreas = (previous: string) => {
        const union = new Set([...parseAreas(previous), ...batchAreas]);
        const areas = REPLAY_AREAS.filter((area) => union.has(area));
        return areas.length ? `,${areas.join(",")},` : "";
      };
      const chunk = {
        recordingId: body.recordingId,
        seq: body.seq,
        firstEventAt: new Date(Math.min(range.first, Date.now())),
        lastEventAt: new Date(Math.min(range.last, Date.now())),
        eventCount: events.length,
        byteCount: gzip.length,
        data: new Uint8Array(gzip),
      };
      if (!existing) {
        // The recording row first: the chunk references it.
        await tx.sessionRecording.create({
          data: {
            id: body.recordingId,
            studentId: student.id,
            startedAt: new Date(
              Math.min(body.startedAt, range.first, Date.now()),
            ),
            lastEventAt: new Date(Math.min(range.last, Date.now())),
            endedAt: body.final
              ? new Date(Math.min(range.last, Date.now()))
              : null,
            entryPath: body.entryPath,
            areas: storedAreas(""),
            userAgent,
            deviceType: parseDeviceType(userAgent),
            viewportWidth: body.viewport.width,
            viewportHeight: body.viewport.height,
            chunkCount: 1,
            eventCount: events.length,
            byteCount: gzip.length,
          },
        });
        await tx.sessionRecordingChunk.create({ data: chunk });
        return NextResponse.json({ ok: true, accepted: true });
      }
      await tx.sessionRecordingChunk.create({ data: chunk });
      const current = existing;
      await tx.sessionRecording.update({
        where: { id: body.recordingId },
        data: {
          areas: storedAreas(current.areas),
          chunkCount: { increment: 1 },
          eventCount: { increment: events.length },
          byteCount: { increment: gzip.length },
          lastEventAt: new Date(
            Math.min(
              Date.now(),
              Math.max(current.lastEventAt.getTime(), range.last),
            ),
          ),
          ...(body.final || current.endedAt
            ? {
                endedAt: new Date(
                  Math.min(
                    Date.now(),
                    Math.max(current.lastEventAt.getTime(), range.last),
                  ),
                ),
              }
            : {}),
        },
      });
      return NextResponse.json({ ok: true, accepted: true });
    });
  } catch (error) {
    // Prisma errors can embed the submitted DOM in their message/stack.
    logApiError(
      "RECORDING_UPLOAD",
      new Error(
        error instanceof Error
          ? `Upload failed (${error.name})`
          : "Upload failed",
      ),
    );
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
