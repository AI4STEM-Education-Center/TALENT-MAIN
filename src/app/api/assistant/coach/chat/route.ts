import { handleAssistantChat } from "@/lib/assistant/chat-handler";

export const runtime = "nodejs";

/**
 * POST /api/assistant/coach/chat
 *
 * One turn of the per-question wrong-answer coach, streamed as NDJSON exactly
 * like /api/assistant/chat plus `action` events for the cards the coach shows.
 * Body: `{ message, attemptId, questionNumber }` — the server verifies the
 * attempt is the caller's and the question was missed before doing anything.
 */
export async function POST(req: Request) {
  return handleAssistantChat(req, "coach");
}
