// Multimodal input: turn the files a user attaches to a chat turn into OpenAI
// chat-completion content parts.
//
// Everything goes through one registry keyed by attachment kind. A kind owns its
// accepted MIME types, its byte ceiling, and how it renders into model input —
// so "we may want PDF/CSV later" costs exactly one entry here (plus the kind in
// `types.ts`), with no change to the agent, the API route, or the UI.
//
// Pure by design: no Prisma, no S3, no SDK. Attachments are inlined into the
// request (base64 data URL for images, decoded text for text-ish files) rather
// than persisted — a chat attachment is scratch input, and not storing it keeps
// student-uploaded imagery out of the bucket and out of backups.

import {
  ATTACHMENT_KINDS,
  type AttachmentKind,
  type IncomingAttachment,
} from "./types";

/** An OpenAI chat content part. Narrowed locally so this module stays SDK-free. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type AttachmentHandler = {
  kind: AttachmentKind;
  label: string;
  /** Exact MIME types this kind accepts, lower-cased. */
  mimeTypes: string[];
  /** File-picker `accept` value for the UI. */
  accept: string;
  /**
   * Hard ceiling for this kind regardless of the admin's per-attachment limit.
   * Text-ish kinds are far cheaper to cap tightly than images.
   */
  maxBytes: number;
  render: (attachment: DecodedAttachment) => ContentPart[];
};

export type DecodedAttachment = IncomingAttachment & {
  kind: AttachmentKind;
  bytes: number;
};

const MIB = 1024 * 1024;

/** Longest text payload handed to the model, in characters. */
export const MAX_TEXT_ATTACHMENT_CHARS = 20_000;

function truncateText(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= MAX_TEXT_ATTACHMENT_CHARS)
    return { text: raw, truncated: false };
  return { text: raw.slice(0, MAX_TEXT_ATTACHMENT_CHARS), truncated: true };
}

function decodeUtf8(dataBase64: string): string {
  return Buffer.from(dataBase64, "base64").toString("utf8");
}

/**
 * Render a text-ish attachment as a fenced block. The fence + filename header
 * keep the model from mistaking file contents for user instructions.
 */
function renderAsText(
  attachment: DecodedAttachment,
  fence: string,
): ContentPart[] {
  const { text, truncated } = truncateText(decodeUtf8(attachment.dataBase64));
  const suffix = truncated
    ? `\n… (truncated at ${MAX_TEXT_ATTACHMENT_CHARS} characters)`
    : "";
  return [
    {
      type: "text",
      text: `Attached file "${attachment.name}":\n\`\`\`${fence}\n${text}${suffix}\n\`\`\``,
    },
  ];
}

const HANDLERS: Record<AttachmentKind, AttachmentHandler> = {
  image: {
    kind: "image",
    label: "Images",
    mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    accept: "image/png,image/jpeg,image/webp,image/gif",
    maxBytes: 10 * MIB,
    render: (attachment) => [
      { type: "text", text: `Attached image "${attachment.name}":` },
      {
        type: "image_url",
        image_url: {
          url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
        },
      },
    ],
  },
  text: {
    kind: "text",
    label: "Text files",
    mimeTypes: ["text/plain", "text/markdown"],
    accept: ".txt,.md,text/plain,text/markdown",
    maxBytes: 1 * MIB,
    render: (attachment) => renderAsText(attachment, ""),
  },
  csv: {
    kind: "csv",
    label: "CSV",
    mimeTypes: ["text/csv", "application/csv"],
    accept: ".csv,text/csv",
    maxBytes: 2 * MIB,
    render: (attachment) => renderAsText(attachment, "csv"),
  },
};

/** Public, UI-safe view of the registry (no handler functions). */
export type AttachmentKindInfo = {
  kind: AttachmentKind;
  label: string;
  accept: string;
  maxBytes: number;
};

export function attachmentKindInfo(
  kinds: AttachmentKind[],
): AttachmentKindInfo[] {
  return kinds.map((kind) => {
    const handler = HANDLERS[kind];
    return {
      kind,
      label: handler.label,
      accept: handler.accept,
      maxBytes: handler.maxBytes,
    };
  });
}

/** Every registered kind, for the admin picker. */
export function allAttachmentKindInfo(): AttachmentKindInfo[] {
  return attachmentKindInfo([...ATTACHMENT_KINDS]);
}

/** The kind that accepts this MIME type, or null when nothing does. */
export function kindForMimeType(mimeType: string): AttachmentKind | null {
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  for (const kind of ATTACHMENT_KINDS) {
    if (HANDLERS[kind].mimeTypes.includes(normalized)) return kind;
  }
  return null;
}

export type AttachmentLimits = {
  /** Kinds the admin enabled for this audience. */
  allowedKinds: AttachmentKind[];
  maxAttachments: number;
  /** Admin per-attachment ceiling; the kind's own `maxBytes` also applies. */
  maxAttachmentBytes: number;
};

export type AttachmentRejection = { name: string; reason: string };

export type AttachmentValidation = {
  accepted: DecodedAttachment[];
  rejected: AttachmentRejection[];
};

// A base64 payload inflates ~4/3 over its bytes; decode the length rather than
// the buffer so an oversized upload is rejected before it is materialized.
function base64Bytes(dataBase64: string): number {
  const clean = dataBase64.replace(/=+$/, "");
  return Math.floor((clean.length * 3) / 4);
}

/**
 * Validate and classify the attachments on one turn. Over-count, unknown MIME
 * type, disabled kind, and oversize are all *rejections* rather than errors: the
 * turn still runs with whatever was acceptable, and the caller tells the user
 * what was dropped (silently ignoring an attachment would read as "the model
 * looked at it").
 */
export function validateAttachments(
  attachments: IncomingAttachment[],
  limits: AttachmentLimits,
): AttachmentValidation {
  const accepted: DecodedAttachment[] = [];
  const rejected: AttachmentRejection[] = [];

  for (const attachment of attachments) {
    const name = attachment.name || "attachment";

    if (accepted.length >= limits.maxAttachments) {
      rejected.push({
        name,
        reason: `over the ${limits.maxAttachments}-attachment limit`,
      });
      continue;
    }

    const kind = kindForMimeType(attachment.mimeType);
    if (!kind) {
      rejected.push({
        name,
        reason: `unsupported file type (${attachment.mimeType})`,
      });
      continue;
    }
    if (!limits.allowedKinds.includes(kind)) {
      rejected.push({
        name,
        reason: `${HANDLERS[kind].label.toLowerCase()} are not enabled`,
      });
      continue;
    }

    const bytes = base64Bytes(attachment.dataBase64);
    const ceiling = Math.min(
      limits.maxAttachmentBytes,
      HANDLERS[kind].maxBytes,
    );
    if (bytes > ceiling) {
      rejected.push({
        name,
        reason: `too large (${Math.round((bytes / MIB) * 10) / 10} MB, limit ${Math.round((ceiling / MIB) * 10) / 10} MB)`,
      });
      continue;
    }

    accepted.push({ ...attachment, name, kind, bytes });
  }

  return { accepted, rejected };
}

/**
 * Build the content parts for one user turn: the typed message first, then each
 * attachment rendered by its handler. Returns a plain string when there are no
 * attachments so text-only turns stay byte-identical to a non-multimodal call
 * (some local OpenAI-compatible servers reject the array form).
 */
export function buildUserContent(
  text: string,
  attachments: DecodedAttachment[],
): string | ContentPart[] {
  if (attachments.length === 0) return text;
  const parts: ContentPart[] = [];
  if (text.trim()) parts.push({ type: "text", text });
  for (const attachment of attachments) {
    parts.push(...HANDLERS[attachment.kind].render(attachment));
  }
  return parts;
}
