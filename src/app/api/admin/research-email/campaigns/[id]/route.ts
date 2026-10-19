import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * DELETE /api/admin/research-email/campaigns/:id — cancel a scheduled send, or
 * stop one mid-send (deliveries not yet sent are skipped).
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id }] = await Promise.all([requireAdminApi(), params]);
  if (session instanceof Response) return session;
  const updated = await prisma.researchEmailCampaign.updateMany({
    where: { id, status: { in: ["SCHEDULED", "SENDING"] } },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
  if (updated.count === 0)
    return NextResponse.json(
      { error: "Only scheduled or in-progress sends can be cancelled." },
      { status: 409 },
    );
  return NextResponse.json({ ok: true });
}
