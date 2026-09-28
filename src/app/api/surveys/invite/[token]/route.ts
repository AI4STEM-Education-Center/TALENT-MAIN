import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import {
  findSurveyInvite,
  recordSurveyResponse,
  toPublicForm,
} from "@/lib/survey-server";

export const runtime = "nodejs";

type Params = { params: Promise<{ token: string }> };

/**
 * Public (no sign-in) post-survey link from a research email. The token is
 * the credential: it is single-person and single-use, and only its SHA-256 is
 * stored. Closing the survey (disabling the form) closes every link to it.
 */
async function load(token: string) {
  const invite = await findSurveyInvite(token);
  if (!invite) return { error: "This survey link is not valid.", status: 404 };
  if (!invite.form.isEnabled || invite.form.status !== "READY")
    return { error: "This survey is closed.", status: 410 };
  return { invite };
}

export async function GET(req: NextRequest, { params }: Params) {
  const limited = rateLimit(req, "survey-invite-read", 60, 60_000);
  if (limited) return limited;
  const { token } = await params;
  const loaded = await load(token);
  if (!loaded.invite)
    return NextResponse.json(
      { error: loaded.error },
      { status: loaded.status },
    );

  const { invite } = loaded;
  const submitted =
    !!invite.usedAt ||
    (invite.userId
      ? !!(await prisma.surveyResponse.findFirst({
          where: { formId: invite.formId, userId: invite.userId },
          select: { id: true },
        }))
      : false);
  return NextResponse.json({
    name: invite.name.split(" ")[0] || invite.name,
    submitted,
    form: submitted ? null : toPublicForm(invite.form),
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  const limited = rateLimit(req, "survey-invite-submit", 10, 60_000);
  if (limited) return limited;
  const { token } = await params;
  const loaded = await load(token);
  if (!loaded.invite)
    return NextResponse.json(
      { error: loaded.error },
      { status: loaded.status },
    );
  const { invite } = loaded;
  if (invite.usedAt)
    return NextResponse.json({ ok: true, alreadySubmitted: true });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await recordSurveyResponse({
    form: invite.form,
    userId: invite.userId,
    name: invite.name,
    email: invite.email,
    source: "LINK",
    answers: body.answers,
  });
  if (!result.ok)
    return NextResponse.json(
      { error: result.error, questionId: result.questionId },
      { status: result.status },
    );

  await prisma.surveyInvite.updateMany({
    where: { id: invite.id, usedAt: null },
    data: { usedAt: new Date(), responseId: result.responseId },
  });
  return NextResponse.json({ ok: true });
}
