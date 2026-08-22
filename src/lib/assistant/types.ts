// Shared types for the student/teacher chat assistants. Kept dependency-free
// (no Prisma, no Next, no OpenAI SDK) so both the pure helpers and the client
// components can import from here.

import type { z } from "zod";

/** The two audiences an assistant can serve. The id doubles as the AssistantConfig row id. */
export const ASSISTANT_AUDIENCES = ["student", "teacher"] as const;
export type AssistantAudience = (typeof ASSISTANT_AUDIENCES)[number];

export function isAssistantAudience(value: unknown): value is AssistantAudience {
  return typeof value === "string" && (ASSISTANT_AUDIENCES as readonly string[]).includes(value);
}

/** The AI use case each audience resolves its provider/model through. */
export const AUDIENCE_USE_CASE = {
  student: "student_assistant",
  teacher: "teacher_assistant",
} as const;

// ─── Attachments (multimodal input) ──────────────────────────────────────────

/**
 * Attachment kinds the registry can turn into model input. Adding a kind here
 * plus a handler in `attachments.ts` is the whole extension path (pdf, xlsx, …);
 * nothing else — schema, API, or UI — needs to change.
 */
export const ATTACHMENT_KINDS = ["image", "text", "csv"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export function isAttachmentKind(value: unknown): value is AttachmentKind {
  return typeof value === "string" && (ATTACHMENT_KINDS as readonly string[]).includes(value);
}

/** One file the user attached to a turn, as it arrives over the wire. */
export type IncomingAttachment = {
  /** Display name, shown back to the user and given to the model as a label. */
  name: string;
  mimeType: string;
  /** Base64 payload WITHOUT a data-URL prefix. */
  dataBase64: string;
};

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * The per-request context every tool handler receives. It carries the resolved
 * identity — never a client-supplied id — so a handler physically cannot read
 * another user's rows: student tools are scoped by `studentId`, teacher tools by
 * `teacherId`, both derived from the session on the server.
 */
export type AssistantToolContext = {
  userId: string;
  audience: AssistantAudience;
  /** Set for the student audience; null for teachers. */
  studentId: string | null;
  /** Set for the teacher audience; null for students. */
  teacherId: string | null;
};

/**
 * A tool the agent may call. `input` is a zod schema: it doubles as the JSON
 * Schema advertised to the model (via z.toJSONSchema) and as the runtime
 * validator for the arguments the model sends back, so the two can't drift.
 *
 * Handlers return plain JSON-serializable data. They are the ONLY way the agent
 * can reach the database — there is no code-execution or raw-query tool, by
 * design.
 */
export type AssistantTool<TSchema extends z.ZodType = z.ZodType> = {
  name: string;
  /** Shown to the model. This is prompt surface — write it for the model to read. */
  description: string;
  input: TSchema;
  /** Short present-tense label the UI shows while the tool runs, e.g. "Searching your results". */
  activityLabel: string;
  handler: (
    args: z.output<TSchema>,
    ctx: AssistantToolContext
  ) => Promise<unknown>;
};

/**
 * A loadable bundle of instructions + tools — the unit an admin toggles per
 * audience. Modelled on an MCP server's capability set (name, description,
 * tool list) so a skill can later be moved behind an MCP transport without its
 * tools changing shape.
 */
export type AssistantSkill = {
  id: string;
  name: string;
  description: string;
  audience: AssistantAudience;
  /** Prompt fragment appended to the system prompt when this skill is loaded. */
  instructions: string;
  tools: AssistantTool[];
};

// ─── Wire protocol (NDJSON, one JSON object per line) ────────────────────────

export type AssistantStreamEvent =
  | { type: "tool"; name: string; label: string; status: "running" | "done" | "error" }
  | { type: "delta"; text: string }
  /**
   * Emitted once, before the model runs, for the attachments on this turn that
   * were stored. The client keeps the ids on its transcript so a later turn can
   * refer back to the same files (see `AssistantTurn.attachmentIds`). An
   * attachment that failed to store simply doesn't appear here.
   */
  | { type: "attachments"; stored: StoredAttachmentRef[] }
  /**
   * Closes a successful turn and carries that turn's generation stats. The
   * model and its provider are kept apart (a gateway's model id already carries
   * a vendor prefix), matching `DisplayAiMetrics` so the chat box can hand the
   * whole thing to the shared metrics line — which renders it on the dev site
   * and nothing at all in production.
   */
  | {
      type: "done";
      model: string;
      provider: string;
      serviceTier: string | null;
      thinkingLevel: string | null;
      ttftMs: number | null;
      generationMs: number | null;
      totalMs: number | null;
      tokens: number;
      tokensEstimated: boolean;
    }
  | { type: "error"; message: string };

/** A persisted attachment as the client sees it: enough to label and re-render it. */
export type StoredAttachmentRef = {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** ISO-8601. When the retention sweep will delete it. */
  expiresAt: string;
};

/** A transcript turn as the client stores and replays it. */
export type AssistantTurn = {
  role: "user" | "assistant";
  content: string;
  /** User turns only: names of the files that were attached (labels, no payload). */
  attachmentNames?: string[];
  /**
   * User turns only: ids of the stored attachments from that turn. The server
   * re-reads the payloads from storage when replaying history, so an image can
   * still be discussed several turns later — bounded by the audience's
   * per-message attachment limit so the context can't grow without end.
   */
  attachmentIds?: string[];
};
