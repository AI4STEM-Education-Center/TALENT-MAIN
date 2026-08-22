import { NextResponse } from "next/server";
import { z } from "zod";
import { readBoundedText, BODY_TOO_LARGE } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit";
import { logApiError, logSystemEvent } from "@/lib/system-log";
import { resolveAssistantSession } from "@/lib/assistant/session";
import { validateAttachments } from "@/lib/assistant/attachments";
import {
  loadStoredAttachments,
  persistAttachments,
} from "@/lib/assistant/attachment-store";
import { runAssistantTurn, MAX_MESSAGE_CHARS } from "@/lib/assistant/agent";
import type { AssistantStreamEvent } from "@/lib/assistant/types";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1000;

/** Slack over the attachment budget for the message, history, and JSON framing. */
const BODY_OVERHEAD_BYTES = 256 * 1024;

const turnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(MAX_MESSAGE_CHARS + 200),
  attachmentNames: z.array(z.string().max(200)).max(8).optional(),
  // Ids the server minted on an earlier turn. Safe to take from the client
  // because every read is re-scoped to the caller's own userId — an id that
  // isn't theirs (or has expired) simply loads nothing.
  attachmentIds: z.array(z.string().max(64)).max(8).optional(),
});

const bodySchema = z.object({
  message: z.string().min(1).max(MAX_MESSAGE_CHARS),
  // Client-held transcript. It is replayed as context only — nothing
  // security-relevant is read from it, and the agent trims it to the configured
  // window, so a tampered history can at worst confuse the model about itself.
  history: z.array(turnSchema).max(60).optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        mimeType: z.string().min(1).max(100),
        dataBase64: z.string().min(1),
      })
    )
    .max(16)
    .optional(),
});

/**
 * POST /api/assistant/chat
 *
 * Runs one assistant turn and streams the result back as NDJSON — one
 * AssistantStreamEvent per line (`delta`, `tool`, `done`, `error`), matching the
 * transport the exam-results endpoint already uses.
 */
export async function POST(req: Request) {
  let session;
  try {
    session = await resolveAssistantSession();
  } catch (error) {
    logApiError("ASSISTANT_CHAT", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { ctx, settings } = session;
  if (!settings.enabled) {
    return NextResponse.json({ error: "This assistant is currently turned off." }, { status: 503 });
  }

  // Keyed by user, not IP: a shared classroom NAT must not make one student's
  // questions exhaust the whole room's budget.
  const limited = rateLimit(req, "assistant-chat", settings.turnsPerHour, HOUR_MS, ctx.userId);
  if (limited) return limited;

  // The cap follows the admin's own attachment limits (base64 inflates ~4/3),
  // so raising them in the panel raises what the endpoint will read — and
  // nothing more.
  const bodyCap =
    BODY_OVERHEAD_BYTES +
    Math.ceil((settings.maxAttachments * settings.maxAttachmentBytes * 4) / 3);
  const raw = await readBoundedText(req, bodyCap);
  if (raw === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  }

  let parsed;
  try {
    parsed = bodySchema.safeParse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { accepted, rejected } = validateAttachments(parsed.data.attachments ?? [], {
    allowedKinds: settings.attachmentKinds,
    maxAttachments: settings.maxAttachments,
    maxAttachmentBytes: settings.maxAttachmentBytes,
  });

  const notices = rejected.map(
    (rejection) => `the attachment "${rejection.name}" was not read: ${rejection.reason}`
  );

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (event: AssistantStreamEvent) => {
        if (closed || req.signal.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      void (async () => {
        try {
          // Keep the turn's files before answering, so the ids can go out ahead
          // of the reply and the client can reference them next turn. Best
          // effort by design: persistAttachments swallows storage failures, and
          // a turn whose attachments could not be kept still gets answered from
          // the inline copies below.
          const stored = await persistAttachments(
            { userId: ctx.userId, audience: ctx.audience },
            accepted,
            settings.attachmentRetentionDays
          );
          if (stored.length > 0) emit({ type: "attachments", stored });

          await runAssistantTurn({
            settings,
            ctx,
            history: parsed.data.history ?? [],
            message: parsed.data.message,
            attachments: accepted,
            notices,
            loadHistoryAttachments: (ids, limit) =>
              loadStoredAttachments(ctx.userId, ids, limit),
            emit,
            signal: req.signal,
          });
        } catch (error) {
          // A provider outage or a malformed upstream response lands here. The
          // detail goes to the admin log; the user gets a plain sentence.
          logApiError("ASSISTANT_CHAT", error);
          void logSystemEvent({
            category: "API",
            type: "ASSISTANT_TURN_FAILED",
            severity: "ERROR",
            message: error instanceof Error ? error.message : String(error),
            userId: ctx.userId,
            metadata: { audience: ctx.audience },
          });
          emit({
            type: "error",
            message: "The assistant could not answer right now. Please try again.",
          });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by a client disconnect — nothing to do.
          }
        }
      })();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
