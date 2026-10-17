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
    include: { _count: { select: { responses: true, invites: true } } },
  });
  if (!form) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { sourceText, pdfBucket, pdfKey, _count, questions, ...rest } = form;
  return NextResponse.json({
    ...rest,
    questions: parseSurveyQuestions(questions),
    hasPdf: !!pdfKey && !!pdfBucket,
    hasSourceText: !!sourceText?.trim(),
    responseCount: _count.responses,
    // Mirrors the PATCH lock: answers and links belong to the form's period.
    periodLocked:
      _count.responses > 0 || _count.invites > 0 || !!rest.promptStartedAt,
  });
}

class PatchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * PATCH /api/admin/surveys/:id — edit title/description/questions/period, or
 * toggle isEnabled / promptInApp.
 *
 * Enabling a form disables any other form for the same survey type, audience
 * and study period, so exactly one pre-survey per role and one post-survey per
 * (role, period) is ever live. Moving an enabled post-survey to another period
 * does the same for the new period. Prisma can't express that as a partial
 * unique index, so the whole read–check–write runs in one interactive
 * transaction that writes first (touching the row) to take SQLite's write
 * lock before re-reading — a parallel PATCH can't move the form between the
 * read and the slot claim.
 *
 * period is locked once the form has responses or invites, or its in-app
 * prompt has ever started: moving it would relabel answers given for one
 * period as another's. A new period gets a new form.
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

  try {
    const questions = await prisma.$transaction(async (tx) => {
      // Write first so this transaction holds the write lock before it reads.
      const touched = await tx.surveyForm.updateMany({
        where: { id },
        data: { updatedAt: new Date() },
      });
      if (touched.count === 0) throw new PatchError("Not found", 404);
      const form = await tx.surveyForm.findUniqueOrThrow({ where: { id } });
      if (form.status === "EXTRACTING")
        throw new PatchError(
          "Wait for the AI extraction to finish before editing.",
          409,
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
        if (!title) throw new PatchError("Title is required.", 400);
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

      if (body.period !== undefined && body.period !== form.period) {
        if (form.kind !== "POST" || !isSurveyPeriod(body.period))
          throw new PatchError(
            "Only post-surveys have a study period (1 or 2).",
            400,
          );
        const [responses, invites] = await Promise.all([
          tx.surveyResponse.count({ where: { formId: id } }),
          tx.surveyInvite.count({ where: { formId: id } }),
        ]);
        if (responses > 0 || invites > 0 || form.promptStartedAt)
          throw new PatchError(
            "This survey's study period can't change once it has responses, emailed links or an in-app prompt — its answers belong to that period. Create a new survey for the other period instead.",
            400,
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
        throw new PatchError(
          "Add at least one question before enabling this survey.",
          400,
        );

      if (typeof body.promptInApp === "boolean") {
        if (body.promptInApp) {
          if (form.kind !== "POST")
            throw new PatchError(
              "Only post-surveys can be prompted in the app.",
              400,
            );
          if (!enabled || form.status !== "READY")
            throw new PatchError(
              "Enable this post-survey before prompting it in the app.",
              400,
            );
          if (!form.promptStartedAt) data.promptStartedAt = new Date();
        }
        data.promptInApp = body.promptInApp;
      }
      if (!enabled) data.promptInApp = false;

      // An enabled form holds its (kind, role, period) slot alone. Claimed on
      // every write while enabled, so the invariant holds whatever a parallel
      // request did before this transaction took the lock.
      if (enabled)
        await tx.surveyForm.updateMany({
          where: {
            kind: form.kind,
            role: form.role,
            period,
            isEnabled: true,
            id: { not: id },
          },
          data: { isEnabled: false, promptInApp: false },
        });
      await tx.surveyForm.update({
        where: { id },
        data: { ...data, isEnabled: enabled },
      });
      return questions;
    });
    return NextResponse.json({ ok: true, questions });
  } catch (error) {
    if (error instanceof PatchError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    throw error;
  }
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
