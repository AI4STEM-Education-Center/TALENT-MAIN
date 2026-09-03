import { prisma } from "@/lib/prisma";

/**
 * Persistent system operation log (SystemLog table), surfaced to admins at
 * /admin/logs. Every write is best-effort: a logging failure is reported to
 * the console but never thrown, so instrumented flows (login, API handlers,
 * worker jobs) can't be broken by their own diagnostics.
 */

export type SystemLogCategory = "AUTH" | "API" | "WORKER" | "USAGE" | "SYSTEM";
export type SystemLogSeverity = "INFO" | "WARNING" | "ERROR";

export interface SystemLogEvent {
  category: SystemLogCategory;
  /** Stable machine-readable event name, e.g. "LOGIN_FAILED" or an API route tag. */
  type: string;
  severity?: SystemLogSeverity;
  message: string;
  userId?: string | null;
  ip?: string | null;
  /** Extra diagnosis context, stored as JSON text. Keep it small and serializable. */
  metadata?: Record<string, unknown>;
}

// Caps keep a runaway error (or an attacker-controlled string) from bloating
// single rows; retention pruning bounds the table's overall size.
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_METADATA_LENGTH = 8_000;

export async function logSystemEvent(event: SystemLogEvent): Promise<void> {
  try {
    let metadata: string | null = null;
    if (event.metadata) {
      metadata = JSON.stringify(event.metadata);
      if (metadata.length > MAX_METADATA_LENGTH) {
        metadata = JSON.stringify({
          truncated: metadata.slice(0, MAX_METADATA_LENGTH),
        });
      }
    }
    await prisma.systemLog.create({
      data: {
        category: event.category,
        type: event.type,
        severity: event.severity ?? "INFO",
        message: event.message.slice(0, MAX_MESSAGE_LENGTH),
        userId: event.userId ?? null,
        ip: event.ip ?? null,
        metadata,
      },
    });
  } catch (err) {
    console.error("[SystemLog] Failed to persist event:", event.type, err);
  }
}

/**
 * Drop-in replacement for the API routes' `console.error("[TAG]", error)`
 * catch-block pattern: keeps the console line and additionally persists the
 * error (with a trimmed stack) for the admin log. Fire-and-forget — callers
 * are about to return a 500 and must not wait on diagnostics.
 */
export function logApiError(
  tag: string,
  error: unknown,
  context?: string,
): void {
  if (context) console.error(`[${tag}] ${context}:`, error);
  else console.error(`[${tag}]`, error);
  const message = error instanceof Error ? error.message : String(error);
  const stack =
    error instanceof Error && error.stack
      ? error.stack.split("\n").slice(0, 12).join("\n")
      : undefined;
  void logSystemEvent({
    category: "API",
    type: tag,
    severity: "ERROR",
    message: context ? `${context}: ${message}` : message,
    metadata: stack ? { stack } : undefined,
  });
}
