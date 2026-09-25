import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { parseJsonBody, questionOrderSchema } from "@/lib/validation";

// PUT: set the display order of a quiz's questions (owner only). The body
// lists every question id in the new order; a partial or foreign list is
// rejected so a stale editor can't silently drop questions to the end.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [actor, { id }] = await Promise.all([getContentActor(), params]);
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await parseJsonBody(questionOrderSchema, req);
  if (!parsed.ok) return parsed.response;
  const { questionIds } = parsed.data;

  const quiz = await prisma.quiz.findUnique({
    where: { id },
    include: { questions: { select: { id: true } } },
  });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const current = new Set(quiz.questions.map((q) => q.id));
  const requested = new Set(questionIds);
  if (
    requested.size !== questionIds.length ||
    requested.size !== current.size ||
    questionIds.some((qid) => !current.has(qid))
  ) {
    return NextResponse.json(
      {
        error:
          "The question list changed since this page loaded. Refresh and try again.",
      },
      { status: 409 },
    );
  }

  await prisma.$transaction(
    questionIds.map((questionId, order) =>
      prisma.question.update({ where: { id: questionId }, data: { order } }),
    ),
  );
  return NextResponse.json({ success: true });
}
