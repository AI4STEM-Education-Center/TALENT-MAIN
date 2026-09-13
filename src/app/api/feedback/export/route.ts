import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { logApiError } from "@/lib/system-log";
import {
  feedbackWhere,
  getFeedbackViewer,
  parseFeedbackFilters,
} from "@/lib/content-feedback-access";
import { summarizeFeedbackBySubject } from "@/lib/content-feedback";
import {
  buildFeedbackCsv,
  buildFeedbackSummaryCsv,
  feedbackCsvFilename,
} from "@/lib/content-feedback-csv";

export const runtime = "nodejs";

/**
 * Hard cap on exported rows. The file is streamed to a browser download, so
 * this is the memory bound on a single request — without it one admin click
 * on a large deployment builds the whole table as a string in a process that
 * serves every other user.
 */
const EXPORT_LIMIT = 20_000;

/**
 * GET /api/feedback/export?view=detail|summary
 *
 * Download the consolidated feedback as CSV, honouring exactly the filters the
 * panel is showing (the same parse + `where` as /api/feedback/summary, so the
 * file matches the screen). `detail` is one line per verdict — rating, the
 * written explanation, who left it, and its class/quiz context. `summary` is
 * one line per rated subject with its average and full 1-5 histogram.
 *
 * Scope is the viewer's, never the query's: a teacher exports the rows routed
 * to them, an admin exports everything.
 */
export async function GET(req: NextRequest) {
  const viewer = await getFeedbackViewer();
  if (!viewer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = rateLimit(req, "feedback-export", 10, 60_000, viewer.userId);
  if (limited) return limited;

  const params = req.nextUrl.searchParams;
  const view = params.get("view") === "summary" ? "summary" : "detail";
  const where = feedbackWhere(viewer, parseFeedbackFilters(params));

  try {
    const rows = await prisma.contentFeedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: EXPORT_LIMIT,
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        audience: true,
        subjectType: true,
        subjectId: true,
        subjectLabel: true,
        subjectDetail: true,
        rating: true,
        comment: true,
        authorName: true,
        authorEmail: true,
        authorRole: true,
        className: true,
        quizName: true,
        attemptId: true,
      },
    });

    const csv =
      view === "summary"
        ? buildFeedbackSummaryCsv(summarizeFeedbackBySubject(rows))
        : buildFeedbackCsv(rows);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${feedbackCsvFilename(view)}"`,
        // The export carries student names and written comments; keep it out
        // of shared caches and browser history replays.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logApiError("CONTENT_FEEDBACK_EXPORT_GET", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
