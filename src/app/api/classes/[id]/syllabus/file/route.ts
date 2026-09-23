import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { signObjectReadUrl, PRESIGN_EXPIRES_SEC } from "@/lib/storage";
import { enrolledClass, findSyllabus, ownedClass } from "@/lib/syllabus-server";

export const runtime = "nodejs";

/**
 * GET /api/classes/[id]/syllabus/file
 * Redirect to a short-lived signed URL for the syllabus PDF. Open to the owning
 * teacher and to enrolled students — once there is extracted content, the
 * document itself is the syllabus they were handed anyway. The signature is
 * minted per click, so the link on the page never goes stale.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id: classId }] = await Promise.all([auth(), params]);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isTeacher = session.user.role === "TEACHER";
  const allowed = isTeacher
    ? await ownedClass(session.user.id, classId)
    : session.user.role === "STUDENT"
      ? await enrolledClass(session.user.id, classId)
      : null;
  if (!allowed)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const syllabus = await findSyllabus(classId);
  if (!syllabus?.storageKey || (!isTeacher && !syllabus.content)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let url: string;
  try {
    url = await signObjectReadUrl(
      syllabus.bucket,
      syllabus.storageKey,
      PRESIGN_EXPIRES_SEC,
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate URL" },
      { status: 500 },
    );
  }

  return NextResponse.redirect(url, {
    status: 302,
    headers: { "Cache-Control": "private, no-store" },
  });
}
