import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getTeacherClass } from "@/lib/class-access";
import { moduleLayoutSchema } from "@/lib/class-modules";
import { getClassModules } from "@/lib/class-modules-server";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Context) {
  const session = await auth();
  if (session?.user?.role !== "TEACHER")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!(await getTeacherClass(session.user.id, id)))
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  return NextResponse.json(await getClassModules(id));
}

class LayoutError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Replace organization atomically. Assignments, publication and results are never removed.
export async function PUT(req: NextRequest, { params }: Context) {
  const session = await auth();
  if (session?.user?.role !== "TEACHER")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id: classId } = await params;
  const cls = await getTeacherClass(session.user.id, classId);
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  const parsed = moduleLayoutSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success)
    return NextResponse.json(
      {
        error:
          "Enter a module name (up to 100 characters) and valid, unique quizzes.",
      },
      { status: 400 },
    );
  const { revision, modules } = parsed.data;
  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.class.updateMany({
        where: { id: classId, modulesRevision: revision },
        data: { modulesRevision: { increment: 1 } },
      });
      if (!updated.count)
        throw new LayoutError(
          "Modules changed in another tab. Reload modules before trying again.",
          409,
        );
      const quizIds = [...new Set(modules.flatMap((module) => module.quizIds))];
      const quizzes = await tx.quiz.findMany({
        where: { id: { in: quizIds }, teacherId: cls.teacherId },
        select: { id: true },
      });
      if (quizzes.length !== quizIds.length)
        throw new LayoutError(
          "One or more quizzes are no longer available.",
          400,
        );
      const foreignModules = await tx.classModule.count({
        where: {
          id: { in: modules.map((module) => module.id) },
          classId: { not: classId },
        },
      });
      if (foreignModules) throw new LayoutError("Invalid module.", 400);
      // Library quizzes become draft class assignments; existing settings stay intact.
      for (const quizId of quizIds)
        await tx.classQuiz.upsert({
          where: { classId_quizId: { classId, quizId } },
          update: {},
          create: { classId, quizId, published: false },
        });
      const assignments = await tx.classQuiz.findMany({
        where: { classId, quizId: { in: quizIds } },
        select: { id: true, quizId: true },
      });
      const assignmentIds = new Map(
        assignments.map((item) => [item.quizId, item.id]),
      );
      await tx.classModule.deleteMany({ where: { classId } });
      for (const [position, module] of modules.entries())
        await tx.classModule.create({
          data: {
            id: module.id,
            classId,
            name: module.name,
            description: module.description,
            position,
            quizzes: {
              create: module.quizIds.map((quizId, index) => ({
                classQuizId: assignmentIds.get(quizId)!,
                position: index,
              })),
            },
          },
        });
    });
    return NextResponse.json({ revision: revision + 1, modules });
  } catch (error) {
    if (error instanceof LayoutError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    throw error;
  }
}
