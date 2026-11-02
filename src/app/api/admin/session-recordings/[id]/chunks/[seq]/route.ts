import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminDataReader } from "@/lib/admin-access";
import { logApiError } from "@/lib/system-log";
import { inflateStoredChunk } from "@/lib/session-recording-server";

type Ctx = { params: Promise<{ id: string; seq: string }> };

/**
 * GET /api/admin/session-recordings/[id]/chunks/[seq]
 * The decoded rrweb events of one uploaded batch. The replay page loads a
 * recording one chunk at a time so a long session never needs a single huge
 * response.
 */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const session = await requireAdminDataReader();
    if (session instanceof Response) return session;
    const { id, seq: rawSeq } = await params;
    const seq = Number(rawSeq);
    if (!Number.isInteger(seq) || seq < 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const chunk = await prisma.sessionRecordingChunk.findUnique({
      where: { recordingId_seq: { recordingId: id, seq } },
      select: { data: true },
    });
    if (!chunk) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(
      { events: inflateStoredChunk(chunk.data) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    logApiError("SESSION_RECORDING_CHUNK", error);
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}
