import { NextResponse } from "next/server";
import {
  cardInteractionSchema,
  saveCardInteraction,
} from "@/lib/assistant/card-interactions";
import { resolveAssistantSession } from "@/lib/assistant/session";
import { rateLimit } from "@/lib/rate-limit";
import { logApiError } from "@/lib/system-log";
import { parseJsonBody } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await resolveAssistantSession();
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { ctx, settings } = session;
    if (!ctx.studentId)
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!settings.enabled)
      return NextResponse.json(
        { error: "This assistant is currently turned off." },
        { status: 503 },
      );

    const limited = rateLimit(
      req,
      "assistant-card-interaction",
      120,
      60_000,
      ctx.userId,
    );
    if (limited) return limited;
    const parsed = await parseJsonBody(cardInteractionSchema, req, 8 * 1024);
    if (!parsed.ok) return parsed.response;

    const interaction = await saveCardInteraction(
      { userId: ctx.userId, audience: ctx.audience, studentId: ctx.studentId },
      settings.historyRetentionDays,
      parsed.data,
    );
    if (!interaction)
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(
      { interaction },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    logApiError("ASSISTANT_CARD_INTERACTION", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
