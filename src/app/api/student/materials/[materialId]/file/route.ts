import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { signObjectReadUrl } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * GET /api/student/materials/[materialId]/file
 * Redirect to a short-lived signed URL for the original PDF of a learning
 * material, for the student's own materials library.
 *
 * Access: the material must be shared (MaterialClass) with a class this student
 * is enrolled in. Anything else is a 404 rather than a 403 — a student must not
 * be able to tell an existing material in someone else's class from a made-up
 * id. Redirecting (rather than returning the signed URL to the page) keeps the
 * href in the UI permanent: the signature is minted per click, so a reader left
 * open past the URL's lifetime still opens the document.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  const [session, { materialId }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
  });
  if (!student)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const material = await prisma.learningMaterial.findFirst({
    where: {
      id: materialId,
      uploadStatus: "READY",
      classLinks: {
        some: { class: { enrollments: { some: { studentId: student.id } } } },
      },
    },
    select: { bucket: true, storageKey: true },
  });
  if (!material)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  let url: string;
  try {
    url = await signObjectReadUrl(material.bucket, material.storageKey, 3600);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate URL" },
      { status: 500 },
    );
  }

  // 302 + no-store: the target expires, so this hop must never be reused from
  // cache or held by an intermediary.
  return NextResponse.redirect(url, {
    status: 302,
    headers: { "Cache-Control": "private, no-store" },
  });
}
