import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { COACH_MAX_EXPLANATION_CHARS } from "@/lib/wrong-answer-coach-messages";
import {
  CoachHttpError,
  handleCoachTurn,
} from "@/lib/wrong-answer-coach-engine";
import { logApiError } from "@/lib/system-log";

const respondSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("explanation"),
    text: z.string().max(COACH_MAX_EXPLANATION_CHARS),
  }),
  z.object({
    type: z.literal("retry_classification"),
  }),
  z.object({
    type: z.literal("second_question"),
    optionToken: z.string().trim().min(1).max(120),
  }),
  z.object({
    type: z.literal("held_out_question"),
    optionToken: z.string().trim().min(1).max(120),
  }),
  z.object({
    type: z.literal("free_text"),
    text: z.string().trim().min(1).max(COACH_MAX_EXPLANATION_CHARS),
  }),
  z.object({
    type: z.literal("leave"),
  }),
]);

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = rateLimit(
    req,
    "coach-respond",
    30,
    3_600_000,
    session.user.id,
  );
  if (limited) return limited;

  const [{ sessionId }, rawBody] = await Promise.all([
    context.params,
    req.json().catch(() => null),
  ]);

  const parsed = respondSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid coach turn payload." },
      { status: 400 },
    );
  }

  try {
    const view = await handleCoachTurn({
      sessionId,
      studentUserId: session.user.id,
      payload: parsed.data,
    });
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof CoachHttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logApiError("COACH_SESSION_RESPOND", err);
    return NextResponse.json(
      { error: "Could not process your response." },
      { status: 500 },
    );
  }
}
