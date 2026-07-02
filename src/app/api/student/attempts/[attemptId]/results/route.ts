import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { presignStoredRecommendations } from "@/lib/exam-results-engine";
import { RESULT_STATUS } from "@/lib/exam-results";
import { enqueueExamResult } from "@/lib/queue";

export const runtime = "nodejs";

// If a section has been stuck non-READY for longer than this, the worker likely
// wasn't running (or crashed) when the job was first enqueued — re-enqueue it.
const STALE_MS = 2 * 60 * 1000;

/**
 * GET the AI summary + recommendations status/content for one of the student's
 * own completed attempts. Polled by the results UI while sections generate.
 * Generation itself is owned by the background worker; this endpoint only reads
 * (and re-enqueues a stale job as a self-healing safety net).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ attemptId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });

  const { attemptId } = await params;
  const examResult = await prisma.examResult.findUnique({
    where: { quizAttemptId: attemptId },
  });
  if (!examResult || examResult.studentId !== student.id) {
    return NextResponse.json({ error: "Result not found" }, { status: 404 });
  }

  // Self-heal: if a section is still PENDING, or has been GENERATING/FAILED
  // beyond the stale window, re-enqueue so a (re)started worker picks it up.
  const stale = Date.now() - examResult.updatedAt.getTime() > STALE_MS;
  const sectionStuck = (status: string) =>
    status === RESULT_STATUS.PENDING ||
    ((status === RESULT_STATUS.GENERATING || status === RESULT_STATUS.FAILED) && stale);
  if (sectionStuck(examResult.summaryStatus) || sectionStuck(examResult.recommendationsStatus)) {
    try {
      enqueueExamResult(examResult.id);
    } catch (err) {
      console.error("[Results] Failed to re-enqueue exam-result generation:", err);
    }
  }

  const recommendations = await presignStoredRecommendations(examResult.recommendations);

  return NextResponse.json({
    summaryStatus: examResult.summaryStatus,
    summary: examResult.summary,
    recommendationsStatus: examResult.recommendationsStatus,
    recommendations: recommendations.items,
    truncated: recommendations.truncated,
    misconceptions: recommendations.misconceptions ?? [],
  });
}
