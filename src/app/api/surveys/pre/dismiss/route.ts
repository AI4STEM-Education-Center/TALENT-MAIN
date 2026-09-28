import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSurveyRole } from "@/lib/survey";
import { getPreSurveyStatus } from "@/lib/survey-server";

export const runtime = "nodejs";

/**
 * POST /api/surveys/pre/dismiss — "No thanks" on the optional pre-survey
 * prompt. Refused when the survey is mandatory (the user agreed to the IRB
 * consent form), so the server, not just the modal, enforces it.
 */
export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role;
  if (!isSurveyRole(role)) return NextResponse.json({ ok: true });

  const status = await getPreSurveyStatus(session.user.id, role);
  if (status.state !== "DUE") return NextResponse.json({ ok: true });
  if (status.mandatory)
    return NextResponse.json(
      {
        error:
          "This survey is required for study participants and can't be skipped.",
      },
      { status: 403 },
    );

  await prisma.surveyPromptDismissal.upsert({
    where: {
      userId_formId: { userId: session.user.id, formId: status.form.id },
    },
    create: { userId: session.user.id, formId: status.form.id },
    update: {},
  });
  return NextResponse.json({ ok: true });
}
