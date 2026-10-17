import { NextResponse } from "next/server";
import { requireAdminDataReader } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/roles";

export const runtime = "nodejs";

/**
 * GET /api/admin/consent-requests
 * An admin sees the requests assigned to them — mirrors the existing
 * /api/pool-submissions reviewer-queue pattern. Only admins can be reviewers,
 * so a research scientist sees every request instead (read-only; deciding
 * stays with the ADMIN-only PATCH on ./[id]).
 */
export async function GET() {
  const session = await requireAdminDataReader();
  if (session instanceof Response) return session;

  const requests = await prisma.consentExportRequest.findMany({
    where: isAdmin(session.user.role) ? { reviewerId: session.user.id } : {},
    include: {
      reviewer: { select: { firstName: true, lastName: true } },
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
