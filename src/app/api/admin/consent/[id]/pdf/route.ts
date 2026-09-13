import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { renderConsentPdf } from "@/lib/consent-pdf";

export const runtime = "nodejs";

/**
 * GET /api/admin/consent/:id/pdf
 * Renders one consent PDF on demand and streams it back — cheap enough (one
 * document, sub-second) to run inline. This is the "preview one or two
 * students" path; anything larger goes through the bulk export job instead
 * (see /api/admin/consent/export). Never persisted.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const [session, { id }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const record = await prisma.consentRecord.findUnique({ where: { id }, include: { formVersion: true } });
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pdf = await renderConsentPdf(record, record.formVersion);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="consent_${record.id.slice(0, 8)}.pdf"`,
    },
  });
}
