// Browser-side attachment preparation for the chat widget.
//
// Images are re-encoded down to MAX_IMAGE_EDGE on their long edge before upload.
// Vision models downsample anyway, so a phone screenshot's full resolution buys
// nothing and costs a multi-megabyte request on a single-instance server; the
// admin's byte limit stays as the backstop for everything this can't shrink
// (non-images, or a browser without canvas).

import type { IncomingAttachment } from "@/lib/assistant/types";

/** Longest edge kept when re-encoding an image, in pixels. */
export const MAX_IMAGE_EDGE = 1568;

/** JPEG quality used when re-encoding a downscaled image. */
const JPEG_QUALITY = 0.85;

export type PreparedAttachment = IncomingAttachment & {
  /**
   * Stable identity for the chip list, minted here at creation rather than
   * derived from filename+index during render: removing a chip shifted every
   * later index, so React reused the wrong preview for the wrong file.
   */
  id: string;
  /** Object URL for the local preview thumbnail. Revoke it when the chip is removed. */
  previewUrl: string | null;
  bytes: number;
};

function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked to stay clear of the argument-count limit on String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function stripDataUrl(dataUrl: string): { mimeType: string; dataBase64: string } {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!match) return { mimeType: "application/octet-stream", dataBase64: "" };
  return { mimeType: match[1], dataBase64: match[2] };
}

async function loadImage(file: File): Promise<HTMLImageElement | null> {
  // react-doctor-disable-next-line react-doctor/no-create-object-url-without-revoke -- revoked in this function's own finally block below
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement | null>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Downscale an image file to a JPEG within MAX_IMAGE_EDGE. Returns null when the
 * browser can't decode or encode it, so the caller falls back to the raw bytes.
 */
async function downscaleImage(
  file: File
): Promise<{ mimeType: string; dataBase64: string } | null> {
  const image = await loadImage(file);
  if (!image || !image.width || !image.height) return null;

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // JPEG has no alpha; paint a white ground so transparent PNGs don't go black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  if (!dataUrl.startsWith("data:image/jpeg;base64,")) return null;
  return stripDataUrl(dataUrl);
}

/**
 * Turn a picked/pasted file into an upload-ready attachment. Images go through
 * the downscaler; everything else is sent verbatim.
 */
export async function prepareAttachment(file: File): Promise<PreparedAttachment> {
  const isImage = file.type.startsWith("image/");

  if (isImage) {
    const shrunk = await downscaleImage(file);
    if (shrunk) {
      return {
        id: crypto.randomUUID(),
        name: file.name || "image.jpg",
        mimeType: shrunk.mimeType,
        dataBase64: shrunk.dataBase64,
        // react-doctor-disable-next-line react-doctor/no-create-object-url-without-revoke -- previewUrl ownership transfers to the caller; AssistantWidget revokes it on send, clear, and remove
        previewUrl: URL.createObjectURL(file),
        bytes: Math.floor((shrunk.dataBase64.length * 3) / 4),
      };
    }
  }

  const dataBase64 = base64FromArrayBuffer(await file.arrayBuffer());
  return {
    id: crypto.randomUUID(),
    name: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    dataBase64,
    // react-doctor-disable-next-line react-doctor/no-create-object-url-without-revoke -- previewUrl ownership transfers to the caller; AssistantWidget revokes it on send, clear, and remove
    previewUrl: isImage ? URL.createObjectURL(file) : null,
    bytes: file.size,
  };
}

/** Human-readable size for the attachment chip. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
