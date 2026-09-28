import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueSurveyExtraction } from "@/lib/queue";
import { resolveSurveyProvider } from "@/lib/survey-extraction-engine";
import { errorMessage } from "@/lib/errors";

export const runtime = "nodejs";

/** POST /api/admin/surveys/:id/extract — re-run the AI conversion of the uploaded PDF. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id }] = await Promise.all([auth(), params]);
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await prisma.surveyForm.findUnique({
    where: { id },
    select: {
      sourceText: true,
      status: true,
      _count: { select: { responses: true } },
    },
  });
  if (!form) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!form.sourceText?.trim())
    return NextResponse.json(
      { error: "This survey wasn't created from a PDF." },
      { status: 400 },
    );
  if (form._count.responses > 0)
    return NextResponse.json(
      {
        error:
          "This survey already has responses; re-extracting would change its questions. Upload the PDF as a new survey instead.",
      },
      { status: 409 },
    );
  if (!(await resolveSurveyProvider()))
    return NextResponse.json(
      {
        error:
          "No AI model is assigned. Assign 'Research Survey PDF Extraction' (or 'Quiz PDF Extraction') in AI Config.",
      },
      { status: 409 },
    );

  const claimed = await prisma.surveyForm.updateMany({
    where: { id, status: { not: "EXTRACTING" } },
    data: { status: "EXTRACTING", errorMessage: null, isEnabled: false },
  });
  if (claimed.count === 0)
    return NextResponse.json({ error: "Already extracting." }, { status: 409 });
  try {
    enqueueSurveyExtraction(id);
  } catch (error) {
    await prisma.surveyForm.update({
      where: { id },
      data: {
        status: "READY",
        errorMessage: `Could not start AI extraction: ${errorMessage(error)}`,
      },
    });
    return NextResponse.json(
      { error: "Could not start AI extraction." },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
