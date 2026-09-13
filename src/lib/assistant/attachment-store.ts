// Persistence for chat attachments.
//
// A file a user attaches is kept for the audience's retention window (30 days by
// default) so a later turn in the same conversation can refer back to it and so
// the upload leaves a record. The bytes go to S3 under
// `assistant-attachments/{userId}/{id}/`; the AssistantAttachment row is the
// index that both authorizes and locates them.
//
// Two invariants hold the design together:
//
//  1. ROW BEFORE OBJECT. The row is written first and the upload follows, so an
//     object can never exist that no row points at — which makes the retention
//     sweep the only deleter the bucket needs. If the upload fails the row is
//     removed again and the turn simply runs without a persisted copy.
//  2. NEVER FATAL. Storage being unconfigured or down must not take chat down.
//     Every function here degrades: persistence returns fewer refs, replay
//     returns fewer attachments, and the turn continues.

import { prisma } from "@/lib/prisma";
import {
  buildAssistantAttachmentKey,
  deleteS3Objects,
  getS3Config,
  getS3Object,
  putS3Object,
} from "@/lib/storage";
import { logSystemEvent } from "@/lib/system-log";
import type { DecodedAttachment } from "./attachments";
import {
  isAttachmentKind,
  type AssistantAudience,
  type StoredAttachmentRef,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows deleted per retention sweep. Bounds one pass; the loop runs hourly. */
const PURGE_BATCH = 500;

export type PersistTarget = { userId: string; audience: AssistantAudience };

/**
 * Store this turn's accepted attachments and return a ref for each one that
 * landed. Failures are logged and skipped rather than thrown: a missing S3
 * configuration should cost the conversation its memory of the file, not the
 * answer the user asked for.
 */
export async function persistAttachments(
  target: PersistTarget,
  attachments: DecodedAttachment[],
  retentionDays: number,
): Promise<StoredAttachmentRef[]> {
  if (attachments.length === 0) return [];

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch {
    // No object storage in this deployment (a local dev box, typically).
    // Attachments still reach the model inline; they just aren't kept.
    return [];
  }

  const expiresAt = new Date(Date.now() + retentionDays * DAY_MS);
  const stored: StoredAttachmentRef[] = [];

  for (const attachment of attachments) {
    let rowId: string | null = null;
    try {
      // Row first: see the invariant at the top of this file.
      const row = await prisma.assistantAttachment.create({
        data: {
          userId: target.userId,
          audience: target.audience,
          name: attachment.name,
          mimeType: attachment.mimeType,
          kind: attachment.kind,
          bytes: attachment.bytes,
          // Filled in below, once the id exists to build the key from.
          storageKey: "",
          bucket,
          expiresAt,
        },
        select: { id: true },
      });
      rowId = row.id;

      const storageKey = buildAssistantAttachmentKey(
        target.userId,
        row.id,
        attachment.name,
      );
      await putS3Object(
        bucket,
        storageKey,
        Buffer.from(attachment.dataBase64, "base64"),
        attachment.mimeType,
      );
      await prisma.assistantAttachment.update({
        where: { id: row.id },
        data: { storageKey },
      });

      stored.push({
        id: row.id,
        name: attachment.name,
        kind: attachment.kind,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      // Roll the index entry back so nothing points at an object that isn't
      // there. A failure here is invisible to the user beyond not being able to
      // refer to the file later, so it is logged for the admin instead.
      if (rowId) {
        await prisma.assistantAttachment
          .delete({ where: { id: rowId } })
          .catch(() => undefined);
      }
      void logSystemEvent({
        category: "API",
        type: "ASSISTANT_ATTACHMENT_STORE_FAILED",
        severity: "WARNING",
        message: `Could not store chat attachment "${attachment.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        userId: target.userId,
        metadata: { audience: target.audience, kind: attachment.kind },
      });
    }
  }

  return stored;
}

/** One stored attachment's row, as the fetch route needs it. */
export type StoredAttachmentRow = {
  id: string;
  name: string;
  mimeType: string;
  kind: string;
  bucket: string;
  storageKey: string;
  expiresAt: Date;
};

/**
 * Look one attachment up for a user. Scoped by `userId` in the query itself —
 * not checked afterwards — so another user's id reads as simply not found, and
 * an attachment past its retention date does too even if the sweep hasn't run
 * yet (the expiry is a promise about access, not just about disk).
 */
export async function findUserAttachment(
  userId: string,
  id: string,
  now = new Date(),
): Promise<StoredAttachmentRow | null> {
  const row = await prisma.assistantAttachment.findFirst({
    where: { id, userId, expiresAt: { gt: now }, storageKey: { not: "" } },
    select: {
      id: true,
      name: true,
      mimeType: true,
      kind: true,
      bucket: true,
      storageKey: true,
      expiresAt: true,
    },
  });
  return row;
}

/** A replayed attachment, carrying the id the transcript referenced it by. */
export type ReplayedAttachment = DecodedAttachment & { id: string };

/**
 * Re-read stored attachments so a previous turn's files can be replayed into the
 * model's context. `ids` is honoured in order and truncated to `limit`, which
 * the caller sets from the audience's per-message attachment cap — replaying a
 * long conversation must not cost more than sending those files once.
 *
 * Anything missing (expired, swept, another user's id, or an object that failed
 * to download) is dropped silently: the turn is better answered with fewer
 * images than not at all.
 */
export async function loadStoredAttachments(
  userId: string,
  ids: string[],
  limit: number,
): Promise<ReplayedAttachment[]> {
  if (ids.length === 0 || limit <= 0) return [];

  const rows = await prisma.assistantAttachment.findMany({
    where: {
      id: { in: ids.slice(0, limit * 4) },
      userId,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      name: true,
      mimeType: true,
      kind: true,
      bytes: true,
      bucket: true,
      storageKey: true,
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  const loaded: ReplayedAttachment[] = [];

  for (const id of ids) {
    if (loaded.length >= limit) break;
    const row = byId.get(id);
    if (!row || !row.storageKey || !isAttachmentKind(row.kind)) continue;
    try {
      const object = await getS3Object(row.bucket, row.storageKey);
      loaded.push({
        id: row.id,
        name: row.name,
        mimeType: row.mimeType,
        dataBase64: Buffer.from(object.body).toString("base64"),
        kind: row.kind,
        bytes: row.bytes,
      });
    } catch {
      // Object gone or storage unreachable — treat it as no longer attached.
    }
  }

  return loaded;
}

/**
 * Delete attachments whose retention window has closed, object and row
 * together. Idempotent, so a missed or repeated run is harmless; the object
 * delete runs first, because a row left behind is retried next pass while a
 * dropped row would leave the object unreachable forever.
 */
export async function purgeExpiredAssistantAttachments(
  now = new Date(),
): Promise<number> {
  const expired = await prisma.assistantAttachment.findMany({
    where: { expiresAt: { lte: now } },
    select: { id: true, bucket: true, storageKey: true },
    take: PURGE_BATCH,
  });
  if (expired.length === 0) return 0;

  const byBucket = new Map<string, string[]>();
  for (const row of expired) {
    if (!row.storageKey) continue;
    const keys = byBucket.get(row.bucket);
    if (keys) keys.push(row.storageKey);
    else byBucket.set(row.bucket, [row.storageKey]);
  }

  for (const [bucket, keys] of byBucket) {
    await deleteS3Objects(bucket, keys);
  }

  const { count } = await prisma.assistantAttachment.deleteMany({
    where: { id: { in: expired.map((row) => row.id) } },
  });
  return count;
}
