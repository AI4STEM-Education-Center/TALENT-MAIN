import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSurveyRole } from "@/lib/survey";
import {
  getEnabledSurveyForm,
  getPreSurveyStatus,
  recordSurveyResponse,
} from "@/lib/survey-server";

export const runtime = "nodejs";

/**
 * GET /api/surveys/pre
 * What the dashboard's SurveyGate should show: nothing, or the enabled
 * pre-survey — mandatory for users who agreed to the IRB consent form,
 * optional for everyone else. Always a fresh read, like /api/consent.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role;
  if (!isSurveyRole(role)) return NextResponse.json({ state: "NONE" });

  const status = await getPreSurveyStatus(session.user.id, role);
  return NextResponse.json({
    ...status,
    defaultEmail: status.state === "DUE" ? session.user.email : undefined,
  });
}

/** POST /api/surveys/pre — submit the signed-in user's pre-survey. */
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

  const form = await getEnabledSurveyForm("PRE", role);
  if (!form || body.formId !== form.id) {
    return NextResponse.json(
      { error: "This survey has changed. Reload the page and try again." },
      { status: 409 },
    );
  }

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
