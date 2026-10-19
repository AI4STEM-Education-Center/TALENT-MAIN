import { NextRequest, NextResponse } from "next/server";
import { requireAdminDataReader } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";
import { getS3Object } from "@/lib/storage";

export const runtime = "nodejs";

/** GET /api/admin/surveys/:id/pdf — the originally uploaded survey PDF. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id }] = await Promise.all([
    requireAdminDataReader(),
    params,
  ]);
  if (session instanceof Response) return session;
  const form = await prisma.surveyForm.findUnique({
    where: { id },
    select: { pdfBucket: true, pdfKey: true, pdfName: true },
  });
  if (!form?.pdfBucket || !form.pdfKey)
    return NextResponse.json({ error: "No PDF stored." }, { status: 404 });
  const obj = await getS3Object(form.pdfBucket, form.pdfKey);
  const name = (form.pdfName || "survey.pdf").replace(/[^\w.\- ]/g, "_");
  return new NextResponse(Buffer.from(obj.body), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
    },
  });
}
