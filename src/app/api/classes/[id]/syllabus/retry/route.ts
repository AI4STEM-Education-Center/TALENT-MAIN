import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueSyllabusExtraction } from "@/lib/queue";
import { rateLimit } from "@/lib/rate-limit";
import { logApiError } from "@/lib/system-log";
import { findSyllabus, ownedClass, toTeacherView } from "@/lib/syllabus-server";

export const runtime = "nodejs";

/**
 * POST /api/classes/[id]/syllabus/retry
 * Re-run extraction on the current source PDF — after a failure, or to discard
 * manual edits and start again from the document. Replaces the content on
 * success, exactly like a fresh upload.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id: classId }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await ownedClass(session.user.id, classId)))
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const limited = rateLimit(req, "syllabus-retry", 5, 60_000, session.user.id);
  if (limited) return limited;

  const syllabus = await findSyllabus(classId);
  if (!syllabus || syllabus.sourceRevision === null) {
    return NextResponse.json(
      { error: "Upload a syllabus first." },
      { status: 404 },
    );
  }
  const revision = syllabus.sourceRevision;

  // A pending upload is abandoned by a retry: the retry works on what is
  // already finalized, and a half-finished upload can simply be started again.
  const claimed = await prisma.classSyllabus.updateMany({
    where: {
      id: syllabus.id,
      sourceRevision: revision,
      status: { not: "EXTRACTING" },
    },
    data: { status: "EXTRACTING", errorMessage: null },
  });
  if (claimed.count !== 1) {
    return NextResponse.json(
      { error: "Extraction is already running." },
      { status: 409 },
    );
  }

  try {
    enqueueSyllabusExtraction(syllabus.id, revision);
  } catch (e) {
    logApiError("SYLLABUS_ENQUEUE", e);
    await prisma.classSyllabus
      .updateMany({
        where: { id: syllabus.id, sourceRevision: revision },
        data: {
          status: "FAILED",
          errorMessage: "Could not queue extraction. Try again.",
        },
      })
      .catch(() => {});
  }

  const row = await findSyllabus(classId);
  return NextResponse.json(
    { syllabus: row ? toTeacherView(row) : null },
    { status: 202 },
  );
}
