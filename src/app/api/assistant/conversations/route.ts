import { NextResponse } from "next/server";
import { resolveAssistantSession } from "@/lib/assistant/session";
import { listUserConversations } from "@/lib/assistant/conversation-store";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

/**
 * GET /api/assistant/conversations
 *
 * The caller's own chat history, newest first, limited to the window an admin
 * configured (AssistantConfig.historyRetentionDays). Anything older is not
 * listed here and cannot be fetched by id either — it has moved to the archive
 * only admins read.
 */
export async function GET() {
  try {
    const session = await resolveAssistantSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { ctx, settings } = session;
    if (!settings.enabled) {
      return NextResponse.json({ error: "This assistant is currently turned off." }, { status: 503 });
    }

    const conversations = await listUserConversations(
      { userId: ctx.userId, audience: ctx.audience },
      settings.historyRetentionDays
    );

    return NextResponse.json({
      conversations,
      retentionDays: settings.historyRetentionDays,
    });
  } catch (error) {
    logApiError("ASSISTANT_CONVERSATIONS", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
