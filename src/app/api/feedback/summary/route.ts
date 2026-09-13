import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logApiError } from "@/lib/system-log";
import {
  feedbackWhere,
  getFeedbackViewer,
  parseFeedbackFilters,
} from "@/lib/content-feedback-access";
import {
  summarizeFeedback,
  summarizeFeedbackBySubject,
} from "@/lib/content-feedback";

export const runtime = "nodejs";

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

/**
 * How many matching rows the histogram/per-subject aggregation reads. The
 * aggregation has to run over the WHOLE filtered set, not the visible page, or
 * "average 2.1" would mean "average of page 3" — but it must also not become
 * an unbounded table scan into memory, so it is capped and the response says
 * when the cap bit.
 */
const AGGREGATE_LIMIT = 5_000;

/**
 * GET /api/feedback/summary
 *
 * The consolidated feedback panel: student verdicts on post-quiz material and
 * simulation recommendations, plus teacher verdicts on generated simulations.
 * Scope comes from the session, never the query — a teacher reads the rows
 * routed to them (their classes' students, and their own submissions), an
 * admin reads everything. See content-feedback-access.ts.
 *
 * Returns three things at once because the panel shows all three: the overall
 * count/average/histogram, the per-subject breakdown worst-average first, and
 * one page of individual verdicts.
 */
export async function GET(req: NextRequest) {
  const viewer = await getFeedbackViewer();
  if (!viewer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const filters = parseFeedbackFilters(params);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Number(params.get("pageSize")) || PAGE_SIZE_DEFAULT),
  );
  const where = feedbackWhere(viewer, filters);

  try {
    const [rows, total, aggregateRows] = await Promise.all([
      prisma.contentFeedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
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
          authorRole: true,
          className: true,
          quizName: true,
          attemptId: true,
        },
      }),
      prisma.contentFeedback.count({ where }),
      prisma.contentFeedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: AGGREGATE_LIMIT,
        select: {
          audience: true,
          subjectType: true,
          subjectId: true,
          subjectLabel: true,
          rating: true,
        },
      }),
    ]);

    // Class filter options, scoped the same way as the rows themselves: the
    // distinct classes that actually have feedback, so the dropdown can never
    // offer a class whose rows the viewer may not read.
    const classRows = await prisma.contentFeedback.findMany({
      where: {
        ...(viewer.role === "TEACHER"
          ? { routedTeacherId: viewer.teacherId }
          : {}),
        classId: { not: null },
      },
      distinct: ["classId"],
      orderBy: { className: "asc" },
      select: { classId: true, className: true },
      take: 200,
    });

    return NextResponse.json({
      viewerRole: viewer.role,
      page,
      pageSize,
      total,
      feedback: rows,
      overall: summarizeFeedback(aggregateRows),
      bySubject: summarizeFeedbackBySubject(aggregateRows),
      byAudience: {
        STUDENT: summarizeFeedback(
          aggregateRows.filter((row) => row.audience === "STUDENT"),
        ),
        TEACHER: summarizeFeedback(
          aggregateRows.filter((row) => row.audience === "TEACHER"),
        ),
      },
      aggregateTruncated: aggregateRows.length >= AGGREGATE_LIMIT,
      classes: classRows.flatMap((row) =>
        row.classId
          ? [{ id: row.classId, name: row.className ?? row.classId }]
          : [],
      ),
    });
  } catch (error) {
    logApiError("CONTENT_FEEDBACK_SUMMARY_GET", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
