import type { Prisma } from "@prisma/client";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  RECORDING_MAX_CHUNK_RAW_BYTES,
  REPLAY_AREAS,
  isReplayArea,
  type ReplayArea,
  validateReplayEvents,
  type ReplayEvent,
} from "./session-recording";

/**
 * Decode one uploaded batch into validated events. The browser sends either a
 * base64 gzip blob (the normal path) or the plain event array (the tiny
 * sendBeacon flush on page unload, where async compression isn't possible).
 * Returns null for anything malformed, over the size ceiling, or not a valid
 * event array.
 */
export function decodeUploadedEvents(
  encoding: "gzip" | "json",
  payload: string,
): { events: ReplayEvent[]; gzip: Buffer } | null {
  let raw: Buffer;
  try {
    raw =
      encoding === "gzip"
        ? gunzipSync(Buffer.from(payload, "base64"), {
            maxOutputLength: RECORDING_MAX_CHUNK_RAW_BYTES,
          })
        : Buffer.from(payload, "utf8");
  } catch {
    return null;
  }
  if (raw.length > RECORDING_MAX_CHUNK_RAW_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  const events = validateReplayEvents(parsed);
  if (!events) return null;

  // Always store gzip. A client-compressed body is kept as sent (it has just
  // been proven to inflate to a valid array); a plain one is compressed here.
  const gzip =
    encoding === "gzip" ? Buffer.from(payload, "base64") : gzipSync(raw);
  return { events, gzip };
}

/** Inflate a stored chunk back to its event array. */
export function inflateStoredChunk(data: Uint8Array): ReplayEvent[] {
  const raw = gunzipSync(data, {
    maxOutputLength: RECORDING_MAX_CHUNK_RAW_BYTES,
  });
  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  return Array.isArray(parsed) ? (parsed as ReplayEvent[]) : [];
}

/** Canonical storage is empty or comma-wrapped tokens, e.g. ",quiz,material,". */
export function parseAreas(stored: string): ReplayArea[] {
  const tokens = new Set(stored.split(","));
  return REPLAY_AREAS.filter((area) => tokens.has(area));
}

/** Invalid/absent filters leave the list unrestricted. */
export function areaWhere(area: unknown): Prisma.SessionRecordingWhereInput {
  return isReplayArea(area) ? { areas: { contains: `,${area},` } } : {};
}
