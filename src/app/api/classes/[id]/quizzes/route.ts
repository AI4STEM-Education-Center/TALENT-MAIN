import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTeacherClass, canReadClass } from "@/lib/class-access";

// GET: list quizzes assigned to this class (with published status)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  // Owning teacher or an enrolled student may read the assigned-quiz list.
  // 404 (not 403) for everyone else so the class's existence isn't disclosed.
  if (!(await canReadClass(session.user, id))) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }

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
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ quizId }, { id }] = await Promise.all([req.json(), params]);
  if (!quizId)
    return NextResponse.json({ error: "quizId required" }, { status: 400 });

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

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
    return NextResponse.json(
      { error: "Quiz already assigned to this class." },
      { status: 409 },
    );
  }
}

/**
 * Parse an incoming availability timestamp: an ISO string → Date, null/"" →
 * null (clear it). `undefined` means "field not present" so the caller leaves
 * it untouched. Throws on an unparseable non-empty value.
 */
function parseDateField(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("invalid date");
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("invalid date");
  return d;
}

/** Parse the maxAttempts field: a positive int → int, null/""/0 → null (unlimited). */
function parseMaxAttempts(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

// PATCH: update published and/or the per-class availability + attempt settings.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [body, { id }] = await Promise.all([req.json(), params]);
  const { quizId, published, availableFrom, availableUntil, maxAttempts } =
    body;
  if (!quizId)
    return NextResponse.json({ error: "quizId required" }, { status: 400 });

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  // Build the update from only the fields actually present in the body, so the
  // existing publish toggle (which sends just { quizId, published }) is
  // unaffected and a settings save doesn't clobber `published`.
  const data: {
    published?: boolean;
    availableFrom?: Date | null;
    availableUntil?: Date | null;
    maxAttempts?: number | null;
  } = {};
  if (published !== undefined) data.published = Boolean(published);
  try {
    const from = parseDateField(availableFrom);
    const until = parseDateField(availableUntil);
    if (from !== undefined) data.availableFrom = from;
    if (until !== undefined) data.availableUntil = until;
  } catch {
    return NextResponse.json({ error: "Invalid date." }, { status: 400 });
  }
  const attempts = parseMaxAttempts(maxAttempts);
  if (attempts !== undefined) data.maxAttempts = attempts;

  const cq = await prisma.classQuiz.updateMany({
    where: { classId: id, quizId },
    data,
  });

  return NextResponse.json(cq);
}

// DELETE: remove quiz from class. Removing the LAST class link deletes the
// quiz itself (questions cascade; QuizAttempt.quizId is SetNull so students'
// attempt history survives) — a quiz in no class must not linger as an
// importable ghost. S3 assets are not touched here: figure/simulation objects
// can be shared by deep copies, so the worker's S3 GC reference-checks and
// sweeps them once nothing references them.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ quizId }, { id }] = await Promise.all([req.json(), params]);

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const removed = await prisma.classQuiz.deleteMany({
    where: { classId: id, quizId },
  });

  let quizDeleted = false;
  // Only a request that actually unlinked something may escalate to deleting
  // the quiz — otherwise a DELETE naming a never-assigned quiz would erase it.
  if (
    removed.count > 0 &&
    (await prisma.classQuiz.count({ where: { quizId } })) === 0
  ) {
    const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
    // Owner check is belt-and-braces: assignment (POST above) only ever links
    // the class teacher's own quizzes, and pool quizzes are never linked.
    if (quiz && quiz.teacherId === cls.teacherId) {
      await prisma.quiz.delete({ where: { id: quizId } });
      quizDeleted = true;
    }
  }

  return NextResponse.json({ success: true, quizDeleted });
}
