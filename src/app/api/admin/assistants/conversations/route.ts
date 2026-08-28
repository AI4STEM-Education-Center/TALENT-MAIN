import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logApiError } from "@/lib/system-log";
import { listConversationsForAdmin } from "@/lib/assistant/conversation-store";
import { isAssistantAudience } from "@/lib/assistant/types";

export const runtime = "nodejs";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * GET /api/admin/assistants/conversations
 *   ?audience=student|teacher &user=<name or email> &q=<text> &page=0 &pageSize=25
 *
 * Every stored chat transcript, hot and archived alike — admins are deliberately
 * exempt from the user-facing retention window, which is what "kept for admins
 * indefinitely" means.
 *
 * `q` matches every conversation's title, but only reaches the message bodies of
 * conversations still in the hot tier: archived turns are JSONL objects in S3
 * and SQL cannot search inside them. The response says so explicitly rather than
 * letting an admin read "no results" as "it was never said".
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const url = new URL(req.url);
    const audience = url.searchParams.get("audience");
    const rawPage = Number.parseInt(url.searchParams.get("page") ?? "0", 10);
    const rawPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "", 10);

    const result = await listConversationsForAdmin({
      audience: isAssistantAudience(audience) ? audience : undefined,
      user: url.searchParams.get("user")?.trim() || undefined,
      q: url.searchParams.get("q")?.trim() || undefined,
      page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0,
      pageSize: Number.isFinite(rawPageSize)
        ? Math.min(Math.max(rawPageSize, 1), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE,
    });

    return NextResponse.json(result);
  } catch (error) {
    logApiError("ADMIN_ASSISTANT_CONVERSATIONS_GET", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
