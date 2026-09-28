import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  buildResearchAttachmentKey,
  getS3Config,
  putS3Object,
} from "@/lib/storage";
import {
  MAX_ATTACHMENT_BYTES,
  type ResearchEmailAttachment,
} from "@/lib/research-email";
import { errorMessage } from "@/lib/errors";

export const runtime = "nodejs";

/**
 * POST /api/admin/research-email/attachments (multipart: file) — store one
 * attachment for a research email and return its metadata; the composer keeps
 * the list and the campaign snapshots it.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let data: FormData;
  try {
    data = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
  }
  const file = data.get("file");
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json({ error: "Choose a file." }, { status: 400 });
  if (file.size > MAX_ATTACHMENT_BYTES)
    return NextResponse.json(
      { error: "Each attachment must be 8 MB or smaller." },
      { status: 413 },
    );

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch {
    return NextResponse.json(
      {
        error:
          "File storage (S3) is not configured, so attachments are unavailable.",
      },
      { status: 503 },
    );
  }
  const id = randomUUID();
  const name = file.name.replace(/[\r\n"]/g, "_").slice(0, 200) || "attachment";
  const key = buildResearchAttachmentKey(id, name);
  const contentType = file.type || "application/octet-stream";
  try {
    await putS3Object(
      bucket,
      key,
      new Uint8Array(await file.arrayBuffer()),
      contentType,
    );
  } catch (error) {
    return NextResponse.json(
      { error: `Upload failed: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
  const attachment: ResearchEmailAttachment = {
    id,
    name,
    size: file.size,
    contentType,
    bucket,
    key,
  };
  return NextResponse.json({ attachment }, { status: 201 });
}
