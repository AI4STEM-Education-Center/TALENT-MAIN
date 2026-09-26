import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseSurveyQuestions, type SurveyAnswers } from "@/lib/survey";
import { buildSurveyResponsesCsv, csvFilename } from "@/lib/survey-csv";

export const runtime = "nodejs";

const PAGE_LIMIT = 500;

function parseAnswers(json: string): SurveyAnswers {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * GET /api/admin/surveys/:id/responses — responses for one form.
 * `?format=csv` downloads every response as CSV; otherwise JSON with the most
 * recent 500 for the dashboard table.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id }] = await Promise.all([auth(), params]);
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await prisma.surveyForm.findUnique({ where: { id } });
  if (!form) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const questions = parseSurveyQuestions(form.questions);
  const asCsv = req.nextUrl.searchParams.get("format") === "csv";

  const [rows, total] = await Promise.all([
    prisma.surveyResponse.findMany({
      where: { formId: id },
      orderBy: { submittedAt: "desc" },
      take: asCsv ? undefined : PAGE_LIMIT,
    }),
    prisma.surveyResponse.count({ where: { formId: id } }),
  ]);
  const responses = rows.map((r) => ({
    id: r.id,
    submittedAt: r.submittedAt,
    role: r.role,
    source: r.source,
    nameSnapshot: r.nameSnapshot,
    emailSnapshot: r.emailSnapshot,
    userId: r.userId,
    irbAgreed: r.irbAgreed,
    interviewOptIn: r.interviewOptIn,
    interviewEmail: r.interviewEmail,
    answers: parseAnswers(r.answers),
  }));

  if (asCsv) {
    const csv = buildSurveyResponsesCsv(questions, responses, {
      includeInterview: form.kind === "PRE",
    });
    return new NextResponse(`﻿${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(`${form.title} responses`)}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({
    form: { id: form.id, title: form.title, kind: form.kind, role: form.role },
    questions,
    responses,
    total,
  });
}
