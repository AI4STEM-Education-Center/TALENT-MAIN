import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { presignStoredRecommendations } from "@/lib/exam-results-engine";
import { RESULT_STATUS } from "@/lib/exam-results";
import { enqueueExamResult } from "@/lib/queue";
import { logApiError } from "@/lib/system-log";
import type {
  PresignedRecommendations,
  ResultComponentMetrics,
} from "@/lib/exam-results";

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
type ExamResultRow = NonNullable<
  Awaited<ReturnType<typeof prisma.examResult.findUnique>>
>;

function componentMetrics(
  model: string | null,
  provider: string | null,
  serviceTier: string | null,
  thinkingLevel: string | null,
  ttftMs: number | null,
  generationMs: number | null,
  totalMs: number | null,
  tokens: number | null,
  tokensEstimated: boolean | null,
): ResultComponentMetrics | null {
  if (
    model === null &&
    ttftMs === null &&
    generationMs === null &&
    totalMs === null &&
    tokens === null
  ) {
    return null;
  }
  return {
    model,
    provider,
    serviceTier,
    thinkingLevel,
    ttftMs,
    generationMs,
    totalMs,
    tokens,
    tokensEstimated: tokensEstimated === true,
  };
}

async function resultPayload(
  examResult: ExamResultRow,
  presigned?: PresignedRecommendations,
) {
  const recommendations =
    presigned ??
    (await presignStoredRecommendations(examResult.recommendations));

  // NOTE: errorMisconceptions is teacher-only and deliberately NOT included.
  return {
    summaryStatus: examResult.summaryStatus,
    summary: examResult.summary,
    summaryMetrics: componentMetrics(
      examResult.summaryAiModel,
      examResult.summaryAiProvider,
      examResult.summaryServiceTier,
      examResult.summaryThinkingLevel,
      examResult.summaryTtftMs,
      examResult.summaryGenerationMs,
      examResult.summaryTotalMs,
      examResult.summaryTokens,
      examResult.summaryTokensEstimated,
    ),
    recommendationsStatus: examResult.recommendationsStatus,
    recommendations: recommendations.items,
    recommendationMetrics: componentMetrics(
      examResult.recsAiModel,
      examResult.recsAiProvider,
      examResult.recsServiceTier,
      examResult.recsThinkingLevel,
      examResult.recsTtftMs,
      examResult.recsGenerationMs,
      examResult.recsTotalMs,
      examResult.recsTokens,
      examResult.recsTokensEstimated,
    ),
    simulations: recommendations.simulations ?? [],
    truncated: recommendations.truncated,
  };
}

const terminal = (status: string) =>
  status === RESULT_STATUS.READY || status === RESULT_STATUS.FAILED;

function streamResult(request: Request, initial: ExamResultRow): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let current: ExamResultRow | null = initial;
        let lastSent = "";
        let cachedRaw: string | null | undefined;
        let cachedPresigned: PresignedRecommendations | undefined;

        try {
          while (current && !cancelled && !request.signal.aborted) {
            if (
              current.recommendationsStatus === RESULT_STATUS.READY &&
              cachedRaw !== current.recommendations
            ) {
              cachedRaw = current.recommendations;
              cachedPresigned = await presignStoredRecommendations(
                current.recommendations,
              );
            }
            const payload = await resultPayload(
              current,
              current.recommendationsStatus === RESULT_STATUS.READY
                ? cachedPresigned
                : { items: [], truncated: false },
            );
            const serialized = JSON.stringify(payload);
            if (serialized !== lastSent) {
              controller.enqueue(encoder.encode(`${serialized}\n`));
              lastSent = serialized;
            }

            if (
              terminal(current.summaryStatus) &&
              terminal(current.recommendationsStatus)
            ) {
              break;
            }

            await new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer);
                request.signal.removeEventListener("abort", finish);
                resolve();
              };
              const timer = setTimeout(finish, 200);
              request.signal.addEventListener("abort", finish, { once: true });
            });
            if (request.signal.aborted) break;
            current = await prisma.examResult.findUnique({
              where: { id: initial.id },
            });
          }
          if (!cancelled && !request.signal.aborted) controller.close();
        } catch (err) {
          if (!cancelled && !request.signal.aborted) controller.error(err);
        }
      })();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!student)
    return NextResponse.json({ error: "Student not found" }, { status: 404 });

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
    ((status === RESULT_STATUS.GENERATING || status === RESULT_STATUS.FAILED) &&
      stale);
  if (
    sectionStuck(examResult.summaryStatus) ||
    sectionStuck(examResult.recommendationsStatus)
  ) {
    try {
      enqueueExamResult(examResult.id);
    } catch (err) {
      logApiError(
        "STUDENT_RESULTS",
        err,
        "Failed to re-enqueue exam-result generation",
      );
    }
  }

  if (new URL(req.url).searchParams.get("stream") === "1") {
    return streamResult(req, examResult);
  }

  return NextResponse.json(await resultPayload(examResult));
}
