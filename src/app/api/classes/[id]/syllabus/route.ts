import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  buildSyllabusPdfKey,
  getMaxUploadBytes,
  getS3Config,
  presignPutUpload,
  sanitizeFilename,
} from "@/lib/storage";
import { normalizeSyllabusContent } from "@/lib/syllabus";
import {
  enrolledClass,
  findSyllabus,
  ownedClass,
  toStudentView,
  toTeacherView,
} from "@/lib/syllabus-server";
import { readBoundedText, BODY_TOO_LARGE } from "@/lib/request-body";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** An edited syllabus is text only; this is far above any real one. */
const MAX_EDIT_BODY_BYTES = 512 * 1024;

/**
 * GET /api/classes/[id]/syllabus
 * The owning teacher gets the full review view; an enrolled student gets the
 * content only, and only once there is some. Everyone else gets a 404.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const [session, { id: classId }] = await Promise.all([auth(), params]);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role === "TEACHER") {
    if (!(await ownedClass(session.user.id, classId)))
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    const row = await findSyllabus(classId);
    return NextResponse.json({ syllabus: row ? toTeacherView(row) : null });
  }

  if (session.user.role === "STUDENT") {
    if (!(await enrolledClass(session.user.id, classId)))
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    const row = await findSyllabus(classId);
    return NextResponse.json({ syllabus: row ? toStudentView(row) : null });
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * POST /api/classes/[id]/syllabus  { originalName, sizeBytes }
 * Start uploading a syllabus PDF — the first one, or a new version. Opens a new
 * revision and returns a presigned PUT for its PDF. The current content (if
 * any) stays in place until the new revision's extraction succeeds.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const [session, { id: classId }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const cls = await ownedClass(session.user.id, classId);
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "S3 not configured" },
      { status: 500 },
    );
  }

  let body: { originalName?: unknown; sizeBytes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const originalName =
    typeof body.originalName === "string"
      ? sanitizeFilename(body.originalName)
      : "";
  if (!originalName.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json(
      { error: "Only PDF files are supported" },
      { status: 400 },
    );
  }
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : 0;
  const maxBytes = getMaxUploadBytes();
  if (sizeBytes < 1 || sizeBytes > maxBytes) {
    return NextResponse.json(
      { error: `sizeBytes must be between 1 and ${maxBytes}` },
      { status: 400 },
    );
  }

  // Increment in the database, not in JS: two uploads started at once must
  // land in different revision directories.
  const row = await prisma.classSyllabus.upsert({
    where: { classId },
    create: {
      classId,
      teacherId: cls.teacherId,
      bucket,
      status: "PENDING_UPLOAD",
      pendingName: originalName,
    },
    update: {
      revision: { increment: 1 },
      pendingName: originalName,
      // The latest operation is now this upload. Content is left alone.
      status: "PENDING_UPLOAD",
      errorMessage: null,
    },
  });

  const pendingStorageKey = buildSyllabusPdfKey(
    cls.teacherId,
    classId,
    row.id,
    row.revision,
    originalName,
  );
  await prisma.classSyllabus.updateMany({
    where: { id: row.id, revision: row.revision },
    data: { pendingStorageKey },
  });

  try {
    const presignedUrl = await presignPutUpload(
      bucket,
      pendingStorageKey,
      "application/pdf",
      sizeBytes,
    );
    return NextResponse.json({
      revision: row.revision,
      presignedUrl,
      mimeType: "application/pdf",
    });
  } catch (e) {
    logApiError("SYLLABUS_UPLOAD_INIT", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create upload URL" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/classes/[id]/syllabus  { content }
 * Save the teacher's direct edits. The body goes through the same normalizer
 * as model output, so an edit can't store anything an extraction couldn't.
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const [session, { id: classId }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await ownedClass(session.user.id, classId)))
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const raw = await readBoundedText(req, MAX_EDIT_BODY_BYTES);
  if (raw === BODY_TOO_LARGE)
    return NextResponse.json({ error: "Syllabus too large." }, { status: 413 });

  let body: { content?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.content || typeof body.content !== "object") {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  const content = normalizeSyllabusContent(body.content);

  // Not while an extraction runs: its result would silently replace the edit
  // a moment later.
  const saved = await prisma.classSyllabus.updateMany({
    where: { classId, status: { not: "EXTRACTING" } },
    data: { content: JSON.stringify(content), editedAt: new Date() },
  });
  if (saved.count !== 1) {
    const exists = await findSyllabus(classId);
    return NextResponse.json(
      {
        error: exists
          ? "A new version is being extracted. Wait for it to finish, then edit."
          : "Upload a syllabus first.",
      },
      { status: exists ? 409 : 404 },
    );
  }

  const row = await findSyllabus(classId);
  return NextResponse.json({ syllabus: row ? toTeacherView(row) : null });
}

/**
 * DELETE /api/classes/[id]/syllabus
 * Remove the syllabus entirely. The S3 objects are left to the garbage
 * collector, which sweeps every revision of a row that no longer exists.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const [session, { id: classId }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await ownedClass(session.user.id, classId)))
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  await prisma.classSyllabus.deleteMany({ where: { classId } });
  return NextResponse.json({ ok: true });
}
