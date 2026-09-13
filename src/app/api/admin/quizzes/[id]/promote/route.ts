import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deepCopyQuiz } from "@/lib/quiz-access";

// POST: copy a teacher's quiz into the global pool. Deep copy — the teacher
// keeps (and can keep editing/deleting) their original; the pool snapshot is
// independent from that moment on.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [session, { id }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const source = await prisma.quiz.findUnique({ where: { id } });
  if (!source || source.teacherId === null) {
    return NextResponse.json({ error: "Teacher quiz not found" }, { status: 404 });
  }

  const copy = await deepCopyQuiz(id, null);
  return NextResponse.json(copy, { status: 201 });
}
