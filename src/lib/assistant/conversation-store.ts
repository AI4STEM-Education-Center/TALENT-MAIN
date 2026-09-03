// Persistence for chat transcripts.
//
// Every assistant turn is written to an AssistantConversation and its
// AssistantMessage rows, so a user can come back to a conversation and an admin
// can read what the assistants have been telling people. Storage is two-tiered
// and the tier boundary is the user's visibility window — see the
// AssistantConversation model for the full shape. In short:
//
//   HOT  — AssistantMessage rows, inside AssistantConfig.historyRetentionDays.
//   COLD — one JSONL object in S3, admin-only, kept indefinitely.
//
// Three rules hold this together:
//
//  1. VISIBILITY IS A DATE, NOT A TIER. Every user-facing read filters on
//     `lastMessageAt` against the configured window. Whether the archiver has
//     run yet changes where the bytes are, never who may read them — so a
//     stalled worker can't accidentally extend what a user can see.
//  2. OBJECT BEFORE ROW DELETE. Archiving uploads the transcript, and only then
//     drops the message rows. The inverse of attachment-store's row-first rule,
//     for the same reason: whichever half is written second is the one a crash
//     may lose, and here losing the upload would destroy the only copy.
//  3. NEVER FATAL. Persisting a turn must not be able to fail the turn. The
//     writer swallows and logs; the answer the user asked for still goes out.

import { prisma } from "@/lib/prisma";
import {
  buildAssistantTranscriptKey,
  getS3Config,
  getS3ObjectAsString,
  putS3Object,
} from "@/lib/storage";
import { logSystemEvent } from "@/lib/system-log";
import type {
  AssistantAudience,
  AssistantTurn,
  ConversationSummary,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest conversation title kept, in characters. */
const MAX_TITLE_CHARS = 120;

/** Conversations archived per sweep. Bounds one pass; the loop runs hourly. */
const ARCHIVE_BATCH = 100;

/**
 * Hard ceiling on turns returned for one conversation. Far above
 * `maxHistoryMessages` (which bounds what the *model* replays) — this only
 * bounds what a single read can hand back, so a pathological conversation can't
 * become an unbounded response.
 */
export const MAX_TRANSCRIPT_TURNS = 400;

/** Serialized transcript format version, written into the archive header. */
const TRANSCRIPT_FORMAT = 1;

export type ConversationTarget = {
  userId: string;
  audience: AssistantAudience;
};

/** The instant before which a conversation is out of its owner's window. */
export function historyCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

/**
 * A title for the conversation list, taken from the opening message. First line
 * only: a pasted multi-line question would otherwise make every row the same
 * height as the longest paste.
 */
export function deriveTitle(firstMessage: string): string {
  const line = firstMessage.trim().split("\n", 1)[0]?.trim() ?? "";
  if (!line) return "New conversation";
  return line.length > MAX_TITLE_CHARS
    ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…`
    : line;
}

function parseIdArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Resolve the conversation this turn belongs to, creating one if the client
 * sent no usable id.
 *
 * `requestedId` comes off the wire, so it is only honoured when it names a HOT
 * conversation that belongs to this caller and is still inside their window —
 * anything else (someone else's id, an archived one, a typo) silently starts a
 * new conversation rather than erroring, because the user asked a question and
 * should get an answer either way.
 */
export async function resolveConversation(
  target: ConversationTarget,
  requestedId: string | null,
  firstMessage: string,
  retentionDays: number,
  now = new Date(),
): Promise<string | null> {
  try {
    if (requestedId) {
      const existing = await prisma.assistantConversation.findFirst({
        where: {
          id: requestedId,
          userId: target.userId,
          audience: target.audience,
          archivedAt: null,
          lastMessageAt: { gte: historyCutoff(retentionDays, now) },
        },
        select: { id: true },
      });
      if (existing) return existing.id;
    }

    const created = await prisma.assistantConversation.create({
      data: {
        userId: target.userId,
        audience: target.audience,
        title: deriveTitle(firstMessage),
        lastMessageAt: now,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    void logSystemEvent({
      category: "API",
      type: "ASSISTANT_CONVERSATION_OPEN_FAILED",
      severity: "WARNING",
      message: `Could not open a chat conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
      userId: target.userId,
      metadata: { audience: target.audience },
    });
    return null;
  }
}

/**
 * Append one completed exchange. Both turns and the conversation's counters move
 * in a single transaction, so a history list can never advertise a message count
 * the transcript doesn't have.
 *
 * Best-effort by contract: the caller has already streamed the answer, and a
 * storage failure here must not retroactively turn a good turn into an error.
 */
export async function appendTurn(
  conversationId: string,
  userTurn: {
    content: string;
    attachmentIds: string[];
    attachmentNames: string[];
  },
  assistantText: string,
  now = new Date(),
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      // Bump the counter FIRST and read the result: the post-increment count is
      // this exchange's slot reservation, so two turns racing on the same
      // conversation get disjoint sequence numbers instead of both computing the
      // same one from a stale read.
      const { messageCount } = await tx.assistantConversation.update({
        where: { id: conversationId },
        data: { messageCount: { increment: 2 }, lastMessageAt: now },
        select: { messageCount: true },
      });
      const base = messageCount - 2;

      await tx.assistantMessage.createMany({
        data: [
          {
            conversationId,
            seq: base,
            role: "user",
            content: userTurn.content,
            attachmentIds: JSON.stringify(userTurn.attachmentIds),
            attachmentNames: JSON.stringify(userTurn.attachmentNames),
            createdAt: now,
          },
          {
            conversationId,
            seq: base + 1,
            role: "assistant",
            content: assistantText,
            createdAt: now,
          },
        ],
      });
    });
  } catch (error) {
    void logSystemEvent({
      category: "API",
      type: "ASSISTANT_TRANSCRIPT_WRITE_FAILED",
      severity: "WARNING",
      message: `Could not persist a chat turn: ${
        error instanceof Error ? error.message : String(error)
      }`,
      metadata: { conversationId },
    });
  }
}

function rowsToTurns(
  rows: {
    role: string;
    content: string;
    attachmentIds: string;
    attachmentNames: string;
  }[],
): AssistantTurn[] {
  return rows.map((row) => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    attachmentIds: parseIdArray(row.attachmentIds),
    attachmentNames: parseIdArray(row.attachmentNames),
  }));
}

/**
 * The newest `limit` turns of a HOT conversation, oldest first — the transcript
 * the agent replays as context.
 *
 * Read from the server's own rows rather than from the client's copy, so what
 * the model sees is what was actually said. Returns nothing (and the turn simply
 * runs without context) if the conversation is archived or unreadable.
 */
export async function loadConversationHistory(
  conversationId: string,
  limit: number,
): Promise<AssistantTurn[]> {
  if (limit <= 0) return [];
  try {
    const rows = await prisma.assistantMessage.findMany({
      where: { conversationId },
      orderBy: { seq: "desc" },
      take: Math.min(limit, MAX_TRANSCRIPT_TURNS),
      select: {
        role: true,
        content: true,
        attachmentIds: true,
        attachmentNames: true,
      },
    });
    return rowsToTurns(rows.reverse());
  } catch {
    // A history the server can't read costs the turn its context, nothing more.
    return [];
  }
}

/**
 * The caller's own conversations, newest first, cut off at their window. Ordered
 * and filtered by `lastMessageAt`, which is exactly the index on the model.
 */
export async function listUserConversations(
  target: ConversationTarget,
  retentionDays: number,
  now = new Date(),
): Promise<ConversationSummary[]> {
  const rows = await prisma.assistantConversation.findMany({
    where: {
      userId: target.userId,
      audience: target.audience,
      lastMessageAt: { gte: historyCutoff(retentionDays, now) },
      // Nothing archived is inside the window, but filtering on it too means a
      // clock skew or a retention increase can't surface a conversation whose
      // turns have already moved to S3 and would therefore read as empty.
      archivedAt: null,
      messageCount: { gt: 0 },
    },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      messageCount: true,
      createdAt: true,
      lastMessageAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    messageCount: row.messageCount,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
  }));
}

/**
 * One of the caller's own conversations in full. Scoped by `userId` and by the
 * retention window inside the query itself — not checked afterwards — so another
 * user's id and an aged-out conversation are both simply "not found".
 */
export async function readUserConversation(
  target: ConversationTarget,
  conversationId: string,
  retentionDays: number,
  now = new Date(),
): Promise<{ summary: ConversationSummary; turns: AssistantTurn[] } | null> {
  const row = await prisma.assistantConversation.findFirst({
    where: {
      id: conversationId,
      userId: target.userId,
      audience: target.audience,
      lastMessageAt: { gte: historyCutoff(retentionDays, now) },
      archivedAt: null,
    },
    select: {
      id: true,
      title: true,
      messageCount: true,
      createdAt: true,
      lastMessageAt: true,
    },
  });
  if (!row) return null;

  const rows = await prisma.assistantMessage.findMany({
    where: { conversationId: row.id },
    orderBy: { seq: "asc" },
    take: MAX_TRANSCRIPT_TURNS,
    select: {
      role: true,
      content: true,
      attachmentIds: true,
      attachmentNames: true,
    },
  });

  return {
    summary: {
      id: row.id,
      title: row.title,
      messageCount: row.messageCount,
      createdAt: row.createdAt.toISOString(),
      lastMessageAt: row.lastMessageAt.toISOString(),
    },
    turns: rowsToTurns(rows),
  };
}

// ─── Archival (hot → cold) ───────────────────────────────────────────────────

/** Header line of an archived transcript, so an object found in the bucket explains itself. */
type TranscriptHeader = {
  v: number;
  conversationId: string;
  userId: string;
  audience: string;
  title: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
};

function serializeTranscript(
  header: TranscriptHeader,
  rows: {
    role: string;
    content: string;
    attachmentIds: string;
    attachmentNames: string;
    createdAt: Date;
  }[],
): string {
  const lines = [JSON.stringify(header)];
  for (const row of rows) {
    lines.push(
      JSON.stringify({
        role: row.role,
        content: row.content,
        attachmentIds: parseIdArray(row.attachmentIds),
        attachmentNames: parseIdArray(row.attachmentNames),
        createdAt: row.createdAt.toISOString(),
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Parse an archived transcript back into turns, skipping the header line. */
export function parseTranscript(body: string): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated final line shouldn't cost us the turns before it.
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") continue; // header
    turns.push({
      role: record.role,
      content: typeof record.content === "string" ? record.content : "",
      attachmentIds: Array.isArray(record.attachmentIds)
        ? (record.attachmentIds as string[])
        : [],
      attachmentNames: Array.isArray(record.attachmentNames)
        ? (record.attachmentNames as string[])
        : [],
    });
  }
  return turns;
}

/**
 * Drop aged conversations that never recorded a turn.
 *
 * A row is created before the model answers, so every turn the model fails
 * leaves an empty one behind. They are invisible to users already
 * (`listUserConversations` requires messageCount > 0) and archiving them would
 * write empty objects forever, so they are deleted outright — the one deletion
 * in this module, and it destroys nothing, because there was never a transcript.
 *
 * Runs independently of object storage: unlike archiving, this works on a
 * deployment with no bucket configured.
 */
export async function purgeEmptyConversations(
  cutoffs: { audience: AssistantAudience; cutoff: Date }[],
): Promise<number> {
  let deleted = 0;
  for (const { audience, cutoff } of cutoffs) {
    const { count } = await prisma.assistantConversation.deleteMany({
      where: {
        audience,
        archivedAt: null,
        messageCount: 0,
        lastMessageAt: { lt: cutoff },
      },
    });
    deleted += count;
  }
  return deleted;
}

/**
 * Move conversations that have aged out of their audience's window into S3.
 *
 * The cutoff is per-audience because the window is: the student and teacher
 * assistants are configured separately, so each audience is swept against its
 * own `historyRetentionDays`.
 *
 * Returns the number archived. Zero when object storage isn't configured — the
 * rows then simply stay hot, which costs disk but is otherwise invisible: users
 * still can't see them, because visibility is decided by date and not by tier.
 */
export async function archiveAgedConversations(
  cutoffs: { audience: AssistantAudience; cutoff: Date }[],
  now = new Date(),
): Promise<number> {
  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch {
    return 0;
  }

  let archived = 0;

  for (const { audience, cutoff } of cutoffs) {
    const due = await prisma.assistantConversation.findMany({
      where: {
        audience,
        archivedAt: null,
        lastMessageAt: { lt: cutoff },
        // Empties are purgeEmptyConversations' job; skipping them here keeps
        // this sweep from writing objects with nothing in them.
        messageCount: { gt: 0 },
      },
      orderBy: { lastMessageAt: "asc" },
      take: ARCHIVE_BATCH,
      select: {
        id: true,
        userId: true,
        audience: true,
        title: true,
        createdAt: true,
        lastMessageAt: true,
        messageCount: true,
      },
    });

    for (const conversation of due) {
      try {
        const rows = await prisma.assistantMessage.findMany({
          where: { conversationId: conversation.id },
          orderBy: { seq: "asc" },
          select: {
            role: true,
            content: true,
            attachmentIds: true,
            attachmentNames: true,
            createdAt: true,
          },
        });

        const storageKey = buildAssistantTranscriptKey(
          conversation.userId,
          conversation.id,
        );
        const body = serializeTranscript(
          {
            v: TRANSCRIPT_FORMAT,
            conversationId: conversation.id,
            userId: conversation.userId,
            audience: conversation.audience,
            title: conversation.title,
            createdAt: conversation.createdAt.toISOString(),
            lastMessageAt: conversation.lastMessageAt.toISOString(),
            messageCount: conversation.messageCount,
          },
          rows,
        );

        // Upload first: see invariant 2 at the top of this file. The key is
        // derived from the id alone, so a retried sweep overwrites rather than
        // duplicating.
        await putS3Object(
          bucket,
          storageKey,
          body,
          "application/x-ndjson; charset=utf-8",
        );

        await prisma.$transaction([
          prisma.assistantConversation.update({
            where: { id: conversation.id },
            data: { archivedAt: now, storageKey, bucket },
          }),
          prisma.assistantMessage.deleteMany({
            where: { conversationId: conversation.id },
          }),
        ]);
        archived += 1;
      } catch (error) {
        // Leave it hot and try again next pass. The rows are still the only
        // copy, so failing loudly and moving on is the safe outcome.
        void logSystemEvent({
          category: "WORKER",
          type: "ASSISTANT_TRANSCRIPT_ARCHIVE_FAILED",
          severity: "WARNING",
          message: `Could not archive chat transcript: ${
            error instanceof Error ? error.message : String(error)
          }`,
          metadata: { conversationId: conversation.id, audience },
        });
      }
    }
  }

  return archived;
}

// ─── Admin reads ─────────────────────────────────────────────────────────────

export type AdminConversationFilters = {
  audience?: AssistantAudience;
  /** Substring match against the user's name or email. */
  user?: string;
  /** Substring match against the title and, for hot conversations, message text. */
  q?: string;
  page: number;
  pageSize: number;
};

export type AdminConversationRow = ConversationSummary & {
  audience: string;
  userId: string;
  userName: string;
  userEmail: string;
  /** Where the turns live now — surfaced so an admin can tell why a read is slower. */
  archived: boolean;
};

/**
 * Admin conversation list. Unlike every user-facing read there is NO retention
 * filter here: retaining transcripts past the user's window is the point of the
 * archive, so an admin sees hot and cold alike.
 *
 * Full-text `q` only reaches the message bodies of HOT conversations — cold
 * turns are JSONL in a bucket and SQL cannot see inside them. Titles are matched
 * for both, which is why the title is denormalized onto the conversation row.
 */
export async function listConversationsForAdmin(
  filters: AdminConversationFilters,
): Promise<{ rows: AdminConversationRow[]; total: number }> {
  const where: Record<string, unknown> = {};
  if (filters.audience) where.audience = filters.audience;

  if (filters.q) {
    where.OR = [
      { title: { contains: filters.q } },
      { messages: { some: { content: { contains: filters.q } } } },
    ];
  }

  // Conversations are relation-free on userId (see the model), so the user
  // filter resolves to ids first rather than joining.
  if (filters.user) {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: filters.user } },
          { firstName: { contains: filters.user } },
          { lastName: { contains: filters.user } },
        ],
      },
      select: { id: true },
      take: 500,
    });
    where.userId = { in: users.map((user) => user.id) };
  }

  const [rows, total] = await Promise.all([
    prisma.assistantConversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      skip: filters.page * filters.pageSize,
      take: filters.pageSize,
      select: {
        id: true,
        userId: true,
        audience: true,
        title: true,
        messageCount: true,
        createdAt: true,
        lastMessageAt: true,
        archivedAt: true,
      },
    }),
    prisma.assistantConversation.count({ where }),
  ]);

  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.userId))] } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const byId = new Map(users.map((user) => [user.id, user]));

  return {
    rows: rows.map((row) => {
      const user = byId.get(row.userId);
      return {
        id: row.id,
        userId: row.userId,
        // A deleted user leaves their transcripts behind by design; label them
        // rather than hiding the row.
        userName: user
          ? `${user.firstName} ${user.lastName}`.trim()
          : "(deleted user)",
        userEmail: user?.email ?? "—",
        audience: row.audience,
        title: row.title,
        messageCount: row.messageCount,
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: row.lastMessageAt.toISOString(),
        archived: row.archivedAt !== null,
      };
    }),
    total,
  };
}

/**
 * One conversation in full for an admin, from whichever tier holds it. An
 * archived conversation whose object can't be read returns its metadata with no
 * turns rather than failing, so the admin sees that it exists and that the
 * bucket is the problem.
 */
export async function readConversationForAdmin(
  conversationId: string,
): Promise<
  | (AdminConversationRow & {
      turns: AssistantTurn[];
      transcriptUnavailable: boolean;
    })
  | null
> {
  const row = await prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      audience: true,
      title: true,
      messageCount: true,
      createdAt: true,
      lastMessageAt: true,
      archivedAt: true,
      bucket: true,
      storageKey: true,
    },
  });
  if (!row) return null;

  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { firstName: true, lastName: true, email: true },
  });

  let turns: AssistantTurn[] = [];
  let transcriptUnavailable = false;

  if (row.archivedAt && row.bucket && row.storageKey) {
    try {
      turns = parseTranscript(
        await getS3ObjectAsString(row.bucket, row.storageKey),
      );
    } catch {
      transcriptUnavailable = true;
    }
  } else {
    const messages = await prisma.assistantMessage.findMany({
      where: { conversationId: row.id },
      orderBy: { seq: "asc" },
      take: MAX_TRANSCRIPT_TURNS,
      select: {
        role: true,
        content: true,
        attachmentIds: true,
        attachmentNames: true,
      },
    });
    turns = rowsToTurns(messages);
  }

  return {
    id: row.id,
    userId: row.userId,
    userName: user
      ? `${user.firstName} ${user.lastName}`.trim()
      : "(deleted user)",
    userEmail: user?.email ?? "—",
    audience: row.audience,
    title: row.title,
    messageCount: row.messageCount,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    archived: row.archivedAt !== null,
    turns,
    transcriptUnavailable,
  };
}
