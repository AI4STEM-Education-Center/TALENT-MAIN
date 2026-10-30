import { parseAreas } from "@/lib/session-recording-server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminApi, requireAdminDataReader } from "@/lib/admin-access";
import { logApiError } from "@/lib/system-log";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * GET /api/admin/session-recordings/[id]
 * One recording's metadata and the sequence numbers of its chunks, which the
 * replay page then fetches one at a time. Administrators and research
 * scientists only (see canViewSessionRecordings).
 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const session = await requireAdminDataReader();
    if (session instanceof Response) return session;
    const { id } = await params;

    const recording = await prisma.sessionRecording.findUnique({
      where: { id },
      select: {
        id: true,
        startedAt: true,
        lastEventAt: true,
        endedAt: true,
        entryPath: true,
        areas: true,
        deviceType: true,
        userAgent: true,
        viewportWidth: true,
        viewportHeight: true,
        chunkCount: true,
        eventCount: true,
        byteCount: true,
        student: {
          select: {
            user: {
              select: { firstName: true, lastName: true, email: true },
            },
          },
        },
        chunks: {
          orderBy: { seq: "asc" },
          select: { seq: true, eventCount: true, byteCount: true },
        },
      },
    });
    if (!recording) return notFound();

    const { student, ...rest } = recording;
    return NextResponse.json({
      ...rest,
      areas: parseAreas(recording.areas),
      studentName: `${student.user.firstName} ${student.user.lastName}`.trim(),
      studentEmail: student.user.email,
    });
  } catch (error) {
    logApiError("SESSION_RECORDING_GET", error);
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/session-recordings/[id]
 * Remove a recording and its chunks. Admin-only: researchers are read-only.
 */
export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const session = await requireAdminApi();
    if (session instanceof Response) return session;
    const { id } = await params;

    const { count } = await prisma.sessionRecording.deleteMany({
      where: { id },
    });
    if (count === 0) return notFound();
    return NextResponse.json({ ok: true });
  } catch (error) {
    logApiError("SESSION_RECORDING_DELETE", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
