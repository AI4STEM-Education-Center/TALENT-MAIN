import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isConsentDecision, isConsentRole } from "@/lib/consent";

export const runtime = "nodejs";

const PAGE_SIZE_MAX = 200;

/**
 * GET /api/admin/consent
 * Admin-only browse of consent records, filterable by role/decision/date
 * range. This — plus the single-record PDF route and the bulk export route —
 * are the ONLY surfaces that ever return ConsentRecord data; no teacher-facing
 * route may join or return it (see docs/plans/consent-compliance-plan.md §6).
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const role = params.get("role");
  const decision = params.get("decision");
  const fromDate = params.get("fromDate");
  const toDate = params.get("toDate");
  const page = Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(params.get("pageSize") ?? "50", 10) || 50));

  const where: Record<string, unknown> = {};
  if (role) {
    if (!isConsentRole(role)) return NextResponse.json({ error: "Invalid role filter." }, { status: 400 });
    where.role = role;
  }
  if (decision) {
    if (!isConsentDecision(decision)) return NextResponse.json({ error: "Invalid decision filter." }, { status: 400 });
    where.decision = decision;
  }
  if (fromDate || toDate) {
    const signedAt: { gte?: Date; lte?: Date } = {};
    if (fromDate) {
      const d = new Date(fromDate);
      if (Number.isNaN(d.getTime())) return NextResponse.json({ error: "Invalid fromDate." }, { status: 400 });
      signedAt.gte = d;
    }
    if (toDate) {
      const d = new Date(toDate);
      if (Number.isNaN(d.getTime())) return NextResponse.json({ error: "Invalid toDate." }, { status: 400 });
      signedAt.lte = d;
    }
    where.signedAt = signedAt;
  }

  const [total, records] = await prisma.$transaction([
    prisma.consentRecord.count({ where }),
    prisma.consentRecord.findMany({
      where,
      orderBy: { signedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        role: true,
        decision: true,
        signedAt: true,
        deviceType: true,
        ipAddress: true,
        interviewRecordingConsent: true,
        signerNameSnapshot: true,
        signerEmailSnapshot: true,
        formVersion: { select: { title: true, version: true } },
      },
    }),
  ]);

  return NextResponse.json({ total, page, pageSize, records });
}
