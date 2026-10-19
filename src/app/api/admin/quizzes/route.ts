import { NextResponse } from "next/server";
import { requireAdminDataReader } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";

// GET: admin view of all teacher-owned quizzes (the candidates for promotion
// into the global pool), with owner info and whether a pool copy already exists.
export async function GET() {
  const session = await requireAdminDataReader();
  if (session instanceof Response) return session;

  const quizzes = await prisma.quiz.findMany({
    where: { teacherId: { not: null } },
    include: {
      topic: true,
      teacher: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      },
      _count: { select: { questions: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const promoted = await prisma.quiz.findMany({
    where: { teacherId: null, sourceQuizId: { in: quizzes.map((q) => q.id) } },
    select: { sourceQuizId: true },
  });
  const promotedIds = new Set(promoted.map((q) => q.sourceQuizId));

  return NextResponse.json(
    quizzes.map((q) => ({ ...q, alreadyPromoted: promotedIds.has(q.id) })),
  );
}
