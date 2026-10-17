import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isSurveyPeriod,
  normalizeSurveyQuestions,
  parseSurveyQuestions,
} from "@/lib/survey";

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
 * PATCH /api/admin/surveys/:id — edit title/description/questions/period, or
 * toggle isEnabled / promptInApp.
 *
 * Enabling a form disables any other form for the same survey type, audience
 * and study period in the same transaction, so exactly one pre-survey per role
 * and one post-survey per (role, period) is ever live. Moving an enabled post-
 * survey to another period does the same for the new period.
 *
 * promptInApp (POST only) needs an enabled, READY form; turning it on stamps
 * promptStartedAt the first time — the cutoff for who counts as having been in
 * the study during that period — and keeps the original stamp if it is turned
 * off and on again, so a toggle never widens the audience to people recruited
 * in between. Disabling a form also stops its in-app prompt.
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
    period?: number;
    promptInApp?: boolean;
    promptStartedAt?: Date;
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

  if (body.period !== undefined) {
    if (form.kind !== "POST" || !isSurveyPeriod(body.period))
      return NextResponse.json(
        { error: "Only post-surveys have a study period (1 or 2)." },
        { status: 400 },
      );
    data.period = body.period;
  }
  const period = data.period ?? form.period;

  const enabled =
    typeof body.isEnabled === "boolean" ? body.isEnabled : form.isEnabled;
  if (
    body.isEnabled === true &&
    questions.filter((q) => q.type !== "section").length === 0
  )
    return NextResponse.json(
      { error: "Add at least one question before enabling this survey." },
      { status: 400 },
    );

  if (typeof body.promptInApp === "boolean") {
    if (body.promptInApp) {
      if (form.kind !== "POST")
        return NextResponse.json(
          { error: "Only post-surveys can be prompted in the app." },
          { status: 400 },
        );
      if (!enabled || form.status !== "READY")
        return NextResponse.json(
          { error: "Enable this post-survey before prompting it in the app." },
          { status: 400 },
        );
      if (!form.promptStartedAt) data.promptStartedAt = new Date();
    }
    data.promptInApp = body.promptInApp;
  }
  if (!enabled) data.promptInApp = false;

  // Taking the (role, period) slot: on enable, or when an enabled post-survey
  // moves to a period another enabled form holds.
  const claimSlot =
    enabled && (body.isEnabled === true || period !== form.period);
  if (claimSlot || typeof body.isEnabled === "boolean") {
    await prisma.$transaction(async (tx) => {
      if (claimSlot)
        await tx.surveyForm.updateMany({
          where: {
            kind: form.kind,
            role: form.role,
            period,
            id: { not: id },
          },
          data: { isEnabled: false, promptInApp: false },
        });
      await tx.surveyForm.update({
        where: { id },
        data: { ...data, isEnabled: enabled },
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
