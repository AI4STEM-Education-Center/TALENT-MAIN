import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";
import { deepCopyQuiz } from "@/lib/quiz-access";

// POST: copy a teacher's quiz into the global pool. Deep copy — the teacher
// keeps (and can keep editing/deleting) their original; the pool snapshot is
// independent from that moment on.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id }] = await Promise.all([requireAdminApi(), params]);
  if (session instanceof Response) return session;

  const source = await prisma.quiz.findUnique({ where: { id } });
  if (!source || source.teacherId === null) {
    return NextResponse.json(
      { error: "Teacher quiz not found" },
      { status: 404 },
    );
  }

  const copy = await deepCopyQuiz(id, null);
  return NextResponse.json(copy, { status: 201 });
}
