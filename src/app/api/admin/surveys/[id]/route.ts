import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeSurveyQuestions, parseSurveyQuestions } from "@/lib/survey";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

async function requireAdmin() {
  const session = await auth();
  return session?.user?.role === "ADMIN" ? session : null;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const [session, { id }] = await Promise.all([requireAdmin(), params]);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const form = await prisma.surveyForm.findUnique({
    where: { id },
    include: { _count: { select: { responses: true } } },
  });
  if (!form) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { sourceText, pdfBucket, pdfKey, _count, questions, ...rest } = form;
  return NextResponse.json({
    ...rest,
    questions: parseSurveyQuestions(questions),
    hasPdf: !!pdfKey && !!pdfBucket,
    hasSourceText: !!sourceText?.trim(),
    responseCount: _count.responses,
  });
}

/**
 * PATCH /api/admin/surveys/:id — edit title/description/questions, or toggle
 * isEnabled. Enabling a form disables any other form for the same survey type
 * and audience in the same transaction, so exactly one is ever live.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const [session, { id }] = await Promise.all([requireAdmin(), params]);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const form = await prisma.surveyForm.findUnique({ where: { id } });
  if (!form) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (form.status === "EXTRACTING")
    return NextResponse.json(
      { error: "Wait for the AI extraction to finish before editing." },
      { status: 409 },
    );

  const data: {
    title?: string;
    description?: string;
    questions?: string;
    errorMessage?: null;
  } = {};
  if (typeof body.title === "string") {
    const title = body.title.trim().slice(0, 200);
    if (!title)
      return NextResponse.json(
        { error: "Title is required." },
        { status: 400 },
      );
    data.title = title;
  }
  if (typeof body.description === "string")
    data.description = body.description.trim().slice(0, 4000);
  let questions = parseSurveyQuestions(form.questions);
  if (body.questions !== undefined) {
    questions = normalizeSurveyQuestions(body.questions);
    data.questions = JSON.stringify(questions);
    data.errorMessage = null;
  }

  if (typeof body.isEnabled === "boolean") {
    if (
      body.isEnabled &&
      questions.filter((q) => q.type !== "section").length === 0
    )
      return NextResponse.json(
        { error: "Add at least one question before enabling this survey." },
        { status: 400 },
      );
    const enable = body.isEnabled;
    await prisma.$transaction(async (tx) => {
      if (enable)
        await tx.surveyForm.updateMany({
          where: { kind: form.kind, role: form.role, id: { not: id } },
          data: { isEnabled: false },
        });
      await tx.surveyForm.update({
        where: { id },
        data: { ...data, isEnabled: enable },
      });
    });
  } else if (Object.keys(data).length > 0) {
    await prisma.surveyForm.update({ where: { id }, data });
  }
  return NextResponse.json({ ok: true, questions });
}

/** DELETE — only forms nobody has answered; answered forms are disabled instead. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const [session, { id }] = await Promise.all([requireAdmin(), params]);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const responses = await prisma.surveyResponse.count({
    where: { formId: id },
  });
  if (responses > 0)
    return NextResponse.json(
      {
        error:
          "This survey has responses, which are research data and can't be deleted. Disable it instead.",
      },
      { status: 409 },
    );
  await prisma.surveyForm.deleteMany({ where: { id } });
  return NextResponse.json({ ok: true });
}
