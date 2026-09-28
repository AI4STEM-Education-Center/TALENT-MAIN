import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { appOrigin } from "@/lib/app-url";
import { isResearchEmailKind } from "@/lib/research-email";
import { parseResearchEmailInput } from "@/lib/research-email-input";

export const runtime = "nodejs";

/** GET /api/admin/research-email/campaigns?kind= — send history with delivery counts. */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kind = req.nextUrl.searchParams.get("kind");
  if (!isResearchEmailKind(kind))
    return NextResponse.json({ error: "Unknown email type." }, { status: 400 });

  const campaigns = await prisma.researchEmailCampaign.findMany({
    where: { kind },
    orderBy: { scheduledAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      scheduledAt: true,
      startedAt: true,
      completedAt: true,
      error: true,
      irbSubject: true,
      surveySubject: true,
      replyTo: true,
      audience: true,
      createdAt: true,
    },
  });
  const counts = await prisma.researchEmailDelivery.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: campaigns.map((c) => c.id) } },
    _count: { _all: true },
  });
  const byCampaign = new Map<string, Record<string, number>>();
  for (const c of counts) {
    const entry = byCampaign.get(c.campaignId) ?? {};
    entry[c.status] = c._count._all;
    byCampaign.set(c.campaignId, entry);
  }
  return NextResponse.json({
    campaigns: campaigns.map((c) => {
      const n = byCampaign.get(c.id) ?? {};
      return {
        ...c,
        sent: n.SENT ?? 0,
        failed: n.FAILED ?? 0,
        pending: n.PENDING ?? 0,
      };
    }),
  });
}

/**
 * POST /api/admin/research-email/campaigns — schedule a send. `scheduledAt`
 * omitted (or in the past) means now; the worker picks it up within a minute.
 * Recipients are resolved when it goes out, not now. Also saves the draft.
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
  const parsed = parseResearchEmailInput(body, true);
  if (!parsed.ok)
    return NextResponse.json({ error: parsed.error }, { status: 400 });

  let scheduledAt = new Date();
  if (typeof body.scheduledAt === "string" && body.scheduledAt) {
    const when = new Date(body.scheduledAt);
    if (Number.isNaN(when.getTime()))
      return NextResponse.json(
        { error: "Invalid send time." },
        { status: 400 },
      );
    if (when > scheduledAt) scheduledAt = when;
  }

  const { kind, attachments, ...content } = parsed.value;
  const attachmentsJson = JSON.stringify(attachments);
  const [campaign] = await prisma.$transaction([
    prisma.researchEmailCampaign.create({
      data: {
        kind,
        ...content,
        attachments: attachmentsJson,
        appOrigin: appOrigin(req),
        scheduledAt,
        createdById: session.user.id,
      },
      select: { id: true, scheduledAt: true },
    }),
    prisma.researchEmailTemplate.upsert({
      where: { kind },
      create: {
        kind,
        ...content,
        attachments: attachmentsJson,
        updatedById: session.user.id,
      },
      update: {
        ...content,
        attachments: attachmentsJson,
        updatedById: session.user.id,
      },
    }),
  ]);
  return NextResponse.json({ campaign }, { status: 201 });
}
