import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isSurveyKind,
  isSurveyRole,
  normalizeSurveyQuestions,
} from "@/lib/survey";
import { findSurveyTemplate, SURVEY_TEMPLATES } from "@/lib/survey-templates";

export const runtime = "nodejs";

/** GET /api/admin/surveys — every survey form with its response count. */
export async function GET() {
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const forms = await prisma.surveyForm.findMany({
    orderBy: [{ kind: "desc" }, { role: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      kind: true,
      role: true,
      title: true,
      isEnabled: true,
      status: true,
      errorMessage: true,
      pdfName: true,
      pdfKey: true,
      questions: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { responses: true } },
    },
  });
  return NextResponse.json({
    forms: forms.map(({ questions, pdfKey, _count, ...f }) => ({
      ...f,
      hasPdf: !!pdfKey,
      responseCount: _count.responses,
      questionCount: normalizeSurveyQuestions(safeParse(questions)).filter(
        (q) => q.type !== "section",
      ).length,
    })),
    templates: SURVEY_TEMPLATES.map((t) => ({
      key: t.key,
      kind: t.kind,
      role: t.role,
      title: t.title,
    })),
  });
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

/**
 * POST /api/admin/surveys — create a form from a built-in template
 * ({ templateKey }) or blank ({ kind, role, title }). PDF uploads go through
 * /api/admin/surveys/upload. New forms start disabled.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.templateKey === "string") {
    const template = findSurveyTemplate(body.templateKey);
    if (!template)
      return NextResponse.json({ error: "Unknown template." }, { status: 400 });
    const form = await prisma.surveyForm.create({
      data: {
        kind: template.kind,
        role: template.role,
        title: template.title,
        description: template.description,
        questions: JSON.stringify(template.questions),
        createdById: session.user.id,
      },
      select: { id: true },
    });
    return NextResponse.json({ id: form.id }, { status: 201 });
  }

  if (!isSurveyKind(body.kind) || !isSurveyRole(body.role))
    return NextResponse.json(
      { error: "Choose a survey type and audience." },
      { status: 400 },
    );
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 200)
      : "Untitled survey";
  const form = await prisma.surveyForm.create({
    data: {
      kind: body.kind,
      role: body.role,
      title,
      createdById: session.user.id,
    },
    select: { id: true },
  });
  return NextResponse.json({ id: form.id }, { status: 201 });
}
