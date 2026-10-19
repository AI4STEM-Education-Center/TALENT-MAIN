import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { isSurveyRole } from "@/lib/survey";
import { getDueSurveyStatus, recordSurveyResponse } from "@/lib/survey-server";

export const runtime = "nodejs";

/**
 * GET /api/surveys/due
 * The one survey the dashboard's SurveyGate should show right now:
 * `{ state: "NONE" | "CONSENT_PENDING" }`, or
 * `{ state: "DUE", kind, period, mandatory, form, defaultEmail }` — the
 * pre-survey first, then a due in-app post-survey. Always a fresh read.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role;
  if (!isSurveyRole(role)) return NextResponse.json({ state: "NONE" });

  const status = await getDueSurveyStatus(session.user.id, role);
  return NextResponse.json({
    ...status,
    defaultEmail:
      status.state === "DUE" && status.kind === "PRE"
        ? session.user.email
        : undefined,
  });
}

/**
 * POST /api/surveys/due { formId, answers, interviewOptIn?, interviewEmail? }
 * Submit the survey the server says is due. Any other form is refused, except
 * a re-submission of one the user already answered (a double-click or a retry
 * after the gate moved on), which is a no-op success.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "survey-submit", 10, 60_000);
  if (limited) return limited;

  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role;
  if (!isSurveyRole(role))
    return NextResponse.json(
      { error: "This account type does not take the survey." },
      { status: 403 },
    );

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const formId = typeof body.formId === "string" ? body.formId : "";

  const status = await getDueSurveyStatus(session.user.id, role);
  if (status.state !== "DUE" || status.form.id !== formId) {
    const already = formId
      ? await prisma.surveyResponse.findFirst({
          where: { formId, userId: session.user.id },
          select: { id: true },
        })
      : null;
    if (already) return NextResponse.json({ ok: true });
    return NextResponse.json(
      { error: "This survey has changed. Reload the page and try again." },
      { status: 409 },
    );
  }

  const form = await prisma.surveyForm.findUnique({ where: { id: formId } });
  if (!form)
    return NextResponse.json(
      { error: "This survey has changed. Reload the page and try again." },
      { status: 409 },
    );

  const result = await recordSurveyResponse({
    form,
    userId: session.user.id,
    name: `${session.user.firstName} ${session.user.lastName}`.trim(),
    email: session.user.email,
    source: "APP",
    answers: body.answers,
    interview: {
      optIn: body.interviewOptIn === true,
      email:
        typeof body.interviewEmail === "string" ? body.interviewEmail : null,
    },
  });
  if (!result.ok)
    return NextResponse.json(
      { error: result.error, questionId: result.questionId },
      { status: result.status },
    );
  return NextResponse.json({ ok: true });
}
