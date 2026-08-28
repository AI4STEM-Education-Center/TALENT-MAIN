import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logApiError } from "@/lib/system-log";
import { readConversationForAdmin } from "@/lib/assistant/conversation-store";

export const runtime = "nodejs";

/**
 * GET /api/admin/assistants/conversations/:id
 *
 * One transcript in full, read from whichever tier holds it — message rows while
 * it is hot, the S3 object once it has been archived. The caller doesn't need to
 * know which; `archived` says which tier answered, and `transcriptUnavailable`
 * flags the case where the row exists but its object could not be fetched, so a
 * storage outage reads as an outage rather than as an empty conversation.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const conversation = await readConversationForAdmin(id);
    if (!conversation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(conversation);
  } catch (error) {
    logApiError("ADMIN_ASSISTANT_CONVERSATION_GET", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
