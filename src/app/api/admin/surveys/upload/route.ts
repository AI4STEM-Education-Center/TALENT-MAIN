import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  MAX_SOURCE_TEXT,
  isSurveyKind,
  isSurveyRole,
  parseSurveyText,
  SURVEY_KIND_LABELS,
  SURVEY_ROLE_LABELS,
} from "@/lib/survey";
import {
  buildResearchSurveyPdfKey,
  getS3Config,
  putS3Object,
} from "@/lib/storage";
import { enqueueSurveyExtraction } from "@/lib/queue";
import { resolveSurveyProvider } from "@/lib/survey-extraction-engine";
import { errorMessage } from "@/lib/errors";
import { MAX_ATTACHMENT_BYTES } from "@/lib/research-email";

export const runtime = "nodejs";

/**
 * POST /api/admin/surveys/upload (multipart: file, text, kind, role)
 *
 * The browser extracts the PDF's text (pdfium, same library as the material
 * uploads) and sends it with the file. The server keeps the PDF as the
 * study's record of the instrument, drafts questions from the text right away
 * with the heuristic parser, and — when an AI model is assigned — queues an AI
 * pass that replaces the draft with a cleaner conversion.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let data: FormData;
  try {
    data = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
  }
  const kind = data.get("kind");
  const role = data.get("role");
  const file = data.get("file");
  const text = data.get("text");
  if (!isSurveyKind(kind) || !isSurveyRole(role))
    return NextResponse.json(
      { error: "Choose a survey type and audience." },
      { status: 400 },
    );
  if (!(file instanceof File) || file.type !== "application/pdf")
    return NextResponse.json({ error: "Upload a PDF file." }, { status: 400 });
  if (file.size > MAX_ATTACHMENT_BYTES)
    return NextResponse.json(
      { error: "The PDF is larger than 8 MB." },
      { status: 413 },
    );
  const sourceText =
    typeof text === "string" ? text.slice(0, MAX_SOURCE_TEXT) : "";
  if (!sourceText.trim())
    return NextResponse.json(
      {
        error:
          "No text could be read from this PDF (it may be a scan). Create the survey from a template or blank instead.",
      },
      { status: 422 },
    );

  const draft = parseSurveyText(sourceText);
  const provider = await resolveSurveyProvider();
  const form = await prisma.surveyForm.create({
    data: {
      kind,
      role,
      title:
        draft.title ||
        `${SURVEY_ROLE_LABELS[role]} ${SURVEY_KIND_LABELS[kind].toLowerCase()}`,
      description: draft.description,
      questions: JSON.stringify(draft.questions),
      sourceText,
      pdfName: file.name.slice(0, 200),
      status: provider ? "EXTRACTING" : "READY",
      errorMessage: provider
        ? null
        : "No AI model is assigned to survey extraction, so these questions were read directly from the PDF text. Review them carefully.",
      createdById: session.user.id,
    },
    select: { id: true },
  });

  // Keeping the original PDF is best-effort: a deployment without S3 still
  // gets a working survey.
  try {
    const { bucket } = getS3Config();
    const key = buildResearchSurveyPdfKey(form.id);
    await putS3Object(
      bucket,
      key,
      new Uint8Array(await file.arrayBuffer()),
      "application/pdf",
    );
    await prisma.surveyForm.update({
      where: { id: form.id },
      data: { pdfBucket: bucket, pdfKey: key },
    });
  } catch (error) {
    console.warn("[Survey] Could not store source PDF:", errorMessage(error));
  }

  if (provider) {
    try {
      enqueueSurveyExtraction(form.id);
    } catch (error) {
      await prisma.surveyForm.update({
        where: { id: form.id },
        data: {
          status: "READY",
          errorMessage: `Could not start AI extraction (${errorMessage(error)}). These questions were read directly from the PDF text.`,
        },
      });
    }
  }
  return NextResponse.json({ id: form.id }, { status: 201 });
}
