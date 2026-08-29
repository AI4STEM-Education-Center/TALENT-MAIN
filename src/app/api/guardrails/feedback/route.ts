import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logApiError } from "@/lib/system-log";
import { submitGuardrailFeedback, MAX_FEEDBACK_CHARS } from "@/lib/guardrail-events";

export const runtime = "nodejs";

/**
 * POST /api/guardrails/feedback
 * Body: { eventId, message }
 *
 * Open to any signed-in user — students hit guardrails too, and a student who
 * cannot report a false positive is a student who just stops using the chat.
 * The event must be their own; an id belonging to someone else reads as 404
 * rather than 403, so this cannot be used to probe whether an id exists or how
 * often the guardrails fire for other people.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { eventId, message } = body as { eventId?: unknown; message?: unknown };
  if (typeof eventId !== "string" || !eventId.trim()) {
    return NextResponse.json({ error: "eventId is required." }, { status: 400 });
  }
  if (typeof message !== "string") {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }

  try {
    const result = await submitGuardrailFeedback(eventId.trim(), session.user.id, message);
    if (result === "empty") {
      return NextResponse.json({ error: "Please describe what went wrong." }, { status: 400 });
    }
    if (result === "not_found") {
      return NextResponse.json({ error: "That report could not be matched." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, maxChars: MAX_FEEDBACK_CHARS });
  } catch (error) {
    logApiError("GUARDRAIL_FEEDBACK", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
