import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function getTeacherClass(userId: string, classId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { userId } });
  if (!teacher) return null;
  return prisma.class.findFirst({ where: { id: classId, teacherId: teacher.id } });
}

// GET: list quizzes assigned to this class (with published status)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const classQuizzes = await prisma.classQuiz.findMany({
    where: { classId: id },
    include: {
      quiz: {
        include: {
          topic: true,
          _count: { select: { questions: true } },
        },
      },
    },
    orderBy: [{ quiz: { order: "asc" } }, { quiz: { createdAt: "asc" } }],
  });

  return NextResponse.json(classQuizzes);
}

// POST: assign one of the teacher's own quizzes to their class
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ quizId }, { id }] = await Promise.all([req.json(), params]);
  if (!quizId) return NextResponse.json({ error: "quizId required" }, { status: 400 });

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || quiz.teacherId !== cls.teacherId) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  try {
    const cq = await prisma.classQuiz.create({
      data: { classId: id, quizId, published: false },
      include: { quiz: { include: { topic: true } } },
    });
    return NextResponse.json(cq, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Quiz already assigned to this class." }, { status: 409 });
  }
}

// PATCH: toggle published for a quiz in this class
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ quizId, published }, { id }] = await Promise.all([req.json(), params]);
  if (!quizId) return NextResponse.json({ error: "quizId required" }, { status: 400 });

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const cq = await prisma.classQuiz.updateMany({
    where: { classId: id, quizId },
    data: { published: Boolean(published) },
  });

  return NextResponse.json(cq);
}

// DELETE: remove quiz from class
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ quizId }, { id }] = await Promise.all([req.json(), params]);

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  await prisma.classQuiz.deleteMany({ where: { classId: id, quizId } });
  return NextResponse.json({ success: true });
}
