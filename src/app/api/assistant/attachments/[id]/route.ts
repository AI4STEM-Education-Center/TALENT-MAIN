import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logApiError } from "@/lib/system-log";
import { findUserAttachment } from "@/lib/assistant/attachment-store";
import { signObjectReadUrl } from "@/lib/storage";

export const runtime = "nodejs";

/** Short-lived, matching how the chat panel uses these: render once, now. */
const READ_URL_EXPIRES_SEC = 300;

/**
 * GET /api/assistant/attachments/:id
 *
 * Redirect to a short-lived signed URL for one of the caller's own stored chat
 * attachments, so the chat panel can show a thumbnail for a file it sent earlier
 * without holding the bytes in memory.
 *
 * Authorization is the row lookup itself: `findUserAttachment` filters on the
 * session's user id and on the retention expiry, so somebody else's id and an
 * expired one are both indistinguishable from a nonexistent one — 404, no
 * detail. That matters more here than the usual 403/404 nicety, because these
 * ids appear in a client-held transcript that a user can edit freely.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const attachment = await findUserAttachment(session.user.id, id);
    if (!attachment) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const url = await signObjectReadUrl(
      attachment.bucket,
      attachment.storageKey,
      READ_URL_EXPIRES_SEC
    );
    // 302, not 301: the signed URL expires, so it must never be cached as the
    // permanent location of this id.
    return NextResponse.redirect(url, {
      status: 302,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    logApiError("ASSISTANT_ATTACHMENT_GET", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
