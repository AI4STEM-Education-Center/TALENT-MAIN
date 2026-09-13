import { NextResponse } from "next/server";
import { resolveAssistantSession } from "@/lib/assistant/session";
import { readUserConversation } from "@/lib/assistant/conversation-store";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

/**
 * GET /api/assistant/conversations/:id
 *
 * One of the caller's own conversations in full, so the chat panel can reopen it
 * and keep talking.
 *
 * Authorization is the query, as with stored attachments: `readUserConversation`
 * filters on the session's user id, the audience, AND the retention window, so
 * another user's conversation and one that has aged out are both simply 404.
 * Note that the window — not the archive flag — is what closes access: a user is
 * outside their history the moment the cutoff passes, whether or not the worker
 * has swept yet.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await resolveAssistantSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { ctx, settings } = session;
    if (!settings.enabled) {
      return NextResponse.json({ error: "This assistant is currently turned off." }, { status: 503 });
    }

    const { id } = await params;
    const conversation = await readUserConversation(
      { userId: ctx.userId, audience: ctx.audience },
      id,
      settings.historyRetentionDays
    );
    if (!conversation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(conversation);
  } catch (error) {
    logApiError("ASSISTANT_CONVERSATION_GET", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
