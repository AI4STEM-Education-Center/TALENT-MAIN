import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { deepCopyLearningMaterial } from "@/lib/material-pool";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

// POST: copy a teacher's processed learning material into the global pool.
// Deep copy — files and page images get new S3 keys, so the teacher can keep
// reprocessing or deleting their original without touching the pool snapshot.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  const [session, { materialId }] = await Promise.all([
    requireAdminApi(),
    params,
  ]);
  if (session instanceof Response) return session;

  const source = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    select: { teacherId: true, uploadStatus: true, processingStatus: true },
  });
  if (!source || source.teacherId === null) {
    return NextResponse.json(
      { error: "Teacher material not found" },
      { status: 404 },
    );
  }
  // The pool only lists fully processed materials, so an unfinished copy
  // would be invisible to admins and teachers alike.
  if (
    source.uploadStatus !== "READY" ||
    source.processingStatus !== "SUCCESS"
  ) {
    return NextResponse.json(
      {
        error:
          "Only successfully processed materials can be added to the pool.",
      },
      { status: 409 },
    );
  }

  try {
    const copy = await deepCopyLearningMaterial(materialId, {
      teacherId: null,
      classId: null,
    });
    if (!copy) {
      return NextResponse.json(
        { error: "Teacher material not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ material: copy }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not add to the pool.",
      },
      { status: 500 },
    );
  }
}
