import { NextResponse } from "next/server";
import { requireAdminDataReader } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * GET /api/admin/consent-requests
 * Requests assigned to the signed-in admin — mirrors the existing
 * /api/pool-submissions reviewer-queue pattern.
 */
export async function GET() {
  const session = await requireAdminDataReader();
  if (session instanceof Response) return session;

  const requests = await prisma.consentExportRequest.findMany({
    where: { reviewerId: session.user.id },
    include: {
      teacher: {
        select: {
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      },
      class: { select: { id: true, name: true } },
    },
    orderBy: [{ status: "asc" }, { requestedAt: "desc" }],
  });

  return NextResponse.json({ requests });
}
