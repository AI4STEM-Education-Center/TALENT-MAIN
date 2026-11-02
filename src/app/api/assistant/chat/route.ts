import { handleAssistantChat } from "@/lib/assistant/chat-handler";

export const runtime = "nodejs";

/**
 * POST /api/assistant/chat
 *
 * Runs one assistant turn and streams the result back as NDJSON — one
 * AssistantStreamEvent per line (`delta`, `tool`, `done`, `error`), matching the
 * transport the exam-results endpoint already uses. The pipeline lives in
 * `chat-handler` so the per-question coach route can run the very same one.
 */
export async function POST(req: Request) {
  return handleAssistantChat(req, "widget");
}
