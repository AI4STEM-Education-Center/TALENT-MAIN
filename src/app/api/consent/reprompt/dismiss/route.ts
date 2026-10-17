import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isConsentRole } from "@/lib/consent";
import { getConsentReprompt } from "@/lib/survey-server";

export const runtime = "nodejs";

/**
 * POST /api/consent/reprompt/dismiss — "No thanks" on the IRB re-consent
 * prompt. The campaign is worked out server-side (never trusted from the
 * client). The prompt then stays away until a newer period's prompt starts
 * (see shouldRepromptConsent); campaignKey only records which form it was.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role;
  if (!isConsentRole(role)) return NextResponse.json({ ok: true });

  const reprompt = await getConsentReprompt(session.user.id, role);
  if (!reprompt) return NextResponse.json({ ok: true });

  await prisma.consentRepromptDismissal.upsert({
    where: {
      userId_campaignKey: {
        userId: session.user.id,
        campaignKey: reprompt.campaignKey,
      },
    },
    create: { userId: session.user.id, campaignKey: reprompt.campaignKey },
    update: { dismissedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
