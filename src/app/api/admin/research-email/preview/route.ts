import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  isResearchEmailKind,
  normalizePoolAudience,
  normalizePostSurveyAudience,
} from "@/lib/research-email";
import { previewRecipients } from "@/lib/research-email-server";

export const runtime = "nodejs";

/**
 * POST /api/admin/research-email/preview { kind, audience } — who the email
 * would reach right now, counted per version, with samples for the preview.
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
  if (!isResearchEmailKind(body.kind))
    return NextResponse.json({ error: "Unknown email type." }, { status: 400 });
  const audience =
    body.kind === "POOL"
      ? normalizePoolAudience(body.audience)
      : normalizePostSurveyAudience(body.audience);

  const plan = await previewRecipients(body.kind, JSON.stringify(audience));
  const byVersion: Record<string, number> = {};
  for (const r of plan.recipients)
    byVersion[r.variant] = (byVersion[r.variant] ?? 0) + 1;
  return NextResponse.json({
    count: plan.recipients.length,
    byVersion,
    skipped: plan.skipped,
    recipients: plan.recipients.slice(0, 200).map((r) => ({
      name: r.name,
      email: r.email,
      variant: r.variant,
      vars: r.vars,
    })),
  });
}
