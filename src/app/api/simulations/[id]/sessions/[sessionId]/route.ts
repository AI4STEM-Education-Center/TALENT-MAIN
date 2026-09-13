import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseBody, simulationSessionUpdateSchema } from "@/lib/validation";
import { mergeControlCounts, parseControlCounts } from "@/lib/simulation-telemetry";

export const runtime = "nodejs";

/**
 * POST /api/simulations/[id]/sessions/[sessionId]
 * Record a telemetry batch for an open session. POST (not PATCH) so the final
 * flush can go through navigator.sendBeacon, which only sends POST. The client
 * reports CUMULATIVE per-session totals, so every field is merged with
 * max(stored, incoming) — replays and the fetch/beacon race are idempotent
 * instead of double-counting. Values are clamped by the schema; `ended` stamps
 * endedAt once.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
  const [session, { id, sessionId }] = await Promise.all([auth(), params]);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Only student sessions are recorded" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseBody(simulationSessionUpdateSchema, raw);
  if (!parsed.ok) return parsed.response;

  const [student, row] = await Promise.all([
    prisma.student.findUnique({ where: { userId: session.user.id } }),
    prisma.simulationSession.findUnique({ where: { id: sessionId } }),
  ]);
  if (!student || !row || row.simulationId !== id || row.studentId !== student.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data } = parsed;
  const controls = mergeControlCounts(parseControlCounts(row.controlsJson), data.controls ?? {});
  await prisma.simulationSession.update({
    where: { id: row.id },
    data: {
      dwellMs: Math.max(row.dwellMs, data.dwellMs),
      activeMs: Math.max(row.activeMs, data.activeMs),
      interactionCount: Math.max(row.interactionCount, data.interactionCount),
      paramChanges: Math.max(row.paramChanges, data.paramChanges),
      controlsJson: Object.keys(controls).length > 0 ? JSON.stringify(controls) : null,
      ...(data.ended && !row.endedAt ? { endedAt: new Date() } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
