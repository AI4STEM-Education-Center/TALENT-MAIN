import { NextResponse } from "next/server";
import { requireAdminDataReader } from "@/lib/admin-access";
import { logApiError } from "@/lib/system-log";
import { readConversationForAdmin } from "@/lib/assistant/conversation-store";
import {
  fallbackAdminTurns,
  hydrateAdminTranscript,
} from "@/lib/assistant/admin-transcript-cards";

export const runtime = "nodejs";

/**
 * GET /api/admin/assistants/conversations/:id
 *
 * One transcript in full, read from whichever tier holds it — message rows while
 * it is hot, the S3 object once it has been archived. The caller doesn't need to
 * know which; `archived` says which tier answered, and `transcriptUnavailable`
 * flags the case where the row exists but its object could not be fetched, so a
 * storage outage reads as an outage rather than as an empty conversation.
 *
 * Assistant turns are hydrated with explicit, allowlisted read-only cards
 * (course material pages, diagnostic options, practice question choices/key,
 * and simulation details) and coach conversations include the original
 * question so admins and researchers can inspect everything the student saw.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminDataReader();
  if (session instanceof Response) return session;

  try {
    const { id } = await params;
    const conversation = await readConversationForAdmin(id);
    if (!conversation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Isolate card hydration failures so an outage or schema surprise never
    // blocks an admin from reading the transcript text itself. Raw `actions`
    // and `attachmentIds` are stripped in both paths.
    let turns = fallbackAdminTurns(conversation.turns);
    let coachQuestion = null;
    try {
      const hydrated = await hydrateAdminTranscript(conversation);
      turns = hydrated.turns;
      coachQuestion = hydrated.coachQuestion;
    } catch (hydrationError) {
      logApiError("ADMIN_ASSISTANT_CONVERSATION_HYDRATE", hydrationError);
    }
    return NextResponse.json(
      {
        ...conversation,
        turns,
        coachQuestion,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    logApiError("ADMIN_ASSISTANT_CONVERSATION_GET", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
