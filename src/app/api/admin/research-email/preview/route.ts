import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { isResearchEmailKind, normalizeAudience } from "@/lib/research-email";
import { previewRecipients } from "@/lib/research-email-server";

export const runtime = "nodejs";

/**
 * POST /api/admin/research-email/preview { kind, audience } — who the email
 * would reach right now, counted per version, with samples for the preview.
 */
export async function POST(req: NextRequest) {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isResearchEmailKind(body.kind))
    return NextResponse.json({ error: "Unknown email type." }, { status: 400 });
  const audience = normalizeAudience(body.kind, body.audience);

  const plan = await previewRecipients(body.kind, JSON.stringify(audience));
  const byVersion: Record<string, number> = {};
  for (const r of plan.recipients)
    byVersion[r.variant] = (byVersion[r.variant] ?? 0) + 1;
  return NextResponse.json({
    count: plan.recipients.length,
    byVersion,
    skipped: plan.skipped,
    forms: plan.forms ?? [],
    recipients: plan.recipients.slice(0, 200).map((r) => ({
      name: r.name,
      email: r.email,
      variant: r.variant,
      vars: r.vars,
    })),
  });
}
