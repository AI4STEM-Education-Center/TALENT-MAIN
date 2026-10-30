import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/validation";
import { logApiError } from "@/lib/system-log";
import { resolveAssistantSession } from "@/lib/assistant/session";
import {
  gradeCoachPractice,
  practiceAnswerSchema,
  resolveCoachScope,
} from "@/lib/assistant/coach";
import type { CoachPracticeResult } from "@/lib/assistant/coach-types";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1000;
/** One short answer: far below the app-wide JSON default. */
const BODY_CAP = 8 * 1024;

const bodySchema = practiceAnswerSchema.extend({
  attemptId: z.string().min(1).max(64),
  questionNumber: z.number().int().min(1).max(500),
});

/**
 * POST /api/assistant/coach/practice
 *
 * Grades the student's answer to an alternative-version question the coach
 * offered. Returns only `{ correct }` — never the key or a solution, matching
 * the practice feature — and stores nothing: it is neither a graded attempt nor
 * a practice attempt. The (attempt, question, version, variant) tuple is
 * re-verified from scratch, so an id the student was never offered is a 404.
 */
export async function POST(req: Request) {
  try {
    const session = await resolveAssistantSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { ctx, settings } = session;
    if (!ctx.studentId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!settings.enabled) {
      return NextResponse.json(
        { error: "This assistant is currently turned off." },
        { status: 503 },
      );
    }

    // Single-select grading is a yes/no oracle for ONE alternative question, so
    // the budget is what keeps it a practice tool rather than a guessing loop.
    const limited = rateLimit(
      req,
      "assistant-coach-practice",
      120,
      HOUR_MS,
      ctx.userId,
    );
    if (limited) return limited;

    const parsed = await parseJsonBody(bodySchema, req, BODY_CAP);
    if (!parsed.ok) return parsed.response;

    const scope = await resolveCoachScope(
      ctx.studentId,
      parsed.data.attemptId,
      parsed.data.questionNumber,
    );
    const graded = scope ? await gradeCoachPractice(scope, parsed.data) : null;
    if (!graded) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body: CoachPracticeResult = { correct: graded.correct };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logApiError("ASSISTANT_COACH", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
