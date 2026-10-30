import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasResearchConsent, parseDeviceType } from "@/lib/consent";
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
  seq: z.number().int().min(0).max(RECORDING_MAX_CHUNKS),
  startedAt: z.number().int().positive(),
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

    const existing = await prisma.sessionRecording.findUnique({
      where: { id: body.recordingId },
      select: { studentId: true, byteCount: true, chunkCount: true },
    });
    if (existing && existing.studentId !== student.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // A replay is built from the opening snapshot, so a recording can only
    // begin with a batch that carries one.
    if (!existing && !hasFullSnapshot(events)) return stop("restart");

    if (
      existing &&
      (existing.byteCount + gzip.length > RECORDING_MAX_BYTES ||
        existing.chunkCount >= RECORDING_MAX_CHUNKS)
    ) {
      return stop("recording_full");
    }
    const stored = await prisma.sessionRecording.aggregate({
      where: { studentId: student.id },
      _sum: { byteCount: true },
    });
    if (
      (stored._sum.byteCount ?? 0) + gzip.length >
      RECORDING_MAX_BYTES_PER_STUDENT
    ) {
      return stop("quota");
    }

    const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 400);
    try {
      await prisma.$transaction(async (tx) => {
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
          firstEventAt: new Date(range.first),
          lastEventAt: new Date(range.last),
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
              startedAt: new Date(Math.min(body.startedAt, range.first)),
              lastEventAt: new Date(range.last),
              endedAt: body.final ? new Date(range.last) : null,
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
          return;
        }
        await tx.sessionRecordingChunk.create({ data: chunk });
        const current = await tx.sessionRecording.findUniqueOrThrow({
          where: { id: body.recordingId },
          select: { lastEventAt: true, areas: true },
        });
        await tx.sessionRecording.update({
          where: { id: body.recordingId },
          data: {
            areas: storedAreas(current.areas),
            chunkCount: { increment: 1 },
            eventCount: { increment: events.length },
            byteCount: { increment: gzip.length },
            lastEventAt: new Date(
              Math.max(current.lastEventAt.getTime(), range.last),
            ),
            ...(body.final ? { endedAt: new Date(range.last) } : {}),
          },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // A retried upload of a batch we already stored.
        return NextResponse.json({ ok: true, accepted: true, duplicate: true });
      }
      throw error;
    }

    return NextResponse.json({ ok: true, accepted: true });
  } catch (error) {
    logApiError("RECORDING_UPLOAD", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
