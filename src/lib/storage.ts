import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const PRESIGN_EXPIRES_SEC = 3600;

export function getMaxUploadBytes(): number {
  const raw = process.env.LEARNING_MATERIAL_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

export function sanitizeFilename(name: string): string {
  const base = name.replace(/^.*[/\\]/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(0, 200) || "file";
}

export function buildStorageKey(teacherId: string, classId: string, materialId: string, originalName: string): string {
  const safe = sanitizeFilename(originalName);
  return `learning-materials/${teacherId}/${classId}/${materialId}/${safe}`;
}

export function buildPageStorageKey(teacherId: string, classId: string, materialId: string, pageNumber: number): string {
  return `learning-materials/${teacherId}/${classId}/${materialId}/pages/page-${pageNumber}.png`;
}

/**
 * Returns the material directory prefix for a given object storage key, i.e.
 * everything up to and including the `{materialId}/` segment. Works for both the
 * original file key and page keys since pages live under `{materialId}/pages/`.
 * This decouples S3 cleanup from the classId embedded in the key.
 */
export function materialPrefixFromStorageKey(storageKey: string): string {
  return storageKey.slice(0, storageKey.lastIndexOf("/") + 1);
}

// ─── Quiz PDF extraction keys ─────────────────────────────────────────────────
// Quizzes are not class-scoped; pool quizzes have no teacher, so the owner
// segment falls back to "pool". Everything for one extraction lives under its
// {extractionId}/ prefix so quizExtractionPrefix() can clean it up in one sweep.

export function quizExtractionScope(teacherId: string | null): string {
  return teacherId ?? "pool";
}

export function buildQuizExtractionPdfKey(
  teacherId: string | null,
  quizId: string,
  extractionId: string,
  originalName: string
): string {
  const safe = sanitizeFilename(originalName);
  return `quiz-extractions/${quizExtractionScope(teacherId)}/${quizId}/${extractionId}/${safe}`;
}

export function buildQuizExtractionPageKey(
  teacherId: string | null,
  quizId: string,
  extractionId: string,
  pageNumber: number
): string {
  return `quiz-extractions/${quizExtractionScope(teacherId)}/${quizId}/${extractionId}/pages/page-${pageNumber}.png`;
}

export function buildQuizExtractionFigureKey(
  teacherId: string | null,
  quizId: string,
  extractionId: string,
  questionIndex: number
): string {
  return `quiz-extractions/${quizExtractionScope(teacherId)}/${quizId}/${extractionId}/figures/figure-${questionIndex}.png`;
}

/**
 * Key for a single image answer-choice crop. Deliberately under the SAME
 * `figures/` segment as question figures so the commit-time prefix security
 * check and `quizExtractionPrefix` cleanup sweep cover option images unchanged.
 */
export function buildQuizExtractionOptionImageKey(
  teacherId: string | null,
  quizId: string,
  extractionId: string,
  questionIndex: number,
  optionIndex: number
): string {
  return `quiz-extractions/${quizExtractionScope(teacherId)}/${quizId}/${extractionId}/figures/option-${questionIndex}-${optionIndex}.png`;
}

/** Prefix covering every object of one extraction (PDF, pages, figures). */
export function quizExtractionPrefix(pdfStorageKey: string): string {
  return pdfStorageKey.slice(0, pdfStorageKey.lastIndexOf("/") + 1);
}

export function getS3Config(): { bucket: string; region: string } {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) {
    throw new Error("Learning materials require AWS_S3_BUCKET and AWS_REGION");
  }
  return { bucket, region };
}

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    const endpoint = process.env.AWS_S3_ENDPOINT;
    s3Client = new S3Client({
      region: process.env.AWS_REGION,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      ...(endpoint
        ? {
            endpoint,
            forcePathStyle: true,
          }
        : {}),
    });
  }
  return s3Client;
}

export async function presignPutUpload(
  bucket: string,
  key: string,
  mimeType: string,
  _contentLength: number
): Promise<string> {
  const client = getS3Client();
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: mimeType,
  });
  return getSignedUrl(client, cmd, { expiresIn: PRESIGN_EXPIRES_SEC });
}

export async function presignGetUrl(bucket: string, key: string, expiresIn = PRESIGN_EXPIRES_SEC): Promise<string> {
  const client = getS3Client();
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, cmd, { expiresIn });
}

/**
 * Download an S3 object and return it as a base64 `data:` URL, the form an
 * OpenAI-compatible `image_url` part accepts inline. Used for local model
 * providers (Ollama / vLLM / LM Studio / …) which typically can't reach our
 * presigned S3 URLs over the network, so the image bytes are embedded directly
 * in the chat-completions request instead of linked. The MIME type comes from
 * the object's stored Content-Type, defaulting to image/png (every image we
 * store for vision — rasterized pages, figure and option crops — is a PNG).
 */
export async function getS3ObjectAsDataUrl(bucket: string, key: string): Promise<string> {
  const client = getS3Client();
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`S3 object ${key} has no body`);
  const bytes = await out.Body.transformToByteArray();
  const base64 = Buffer.from(bytes).toString("base64");
  const contentType = out.ContentType || "image/png";
  return `data:${contentType};base64,${base64}`;
}

/**
 * Resolve a stored image into the string an `image_url` model message part
 * expects, picking the transport by provider capability. Hosted providers fetch
 * over HTTP, so they get a short-lived presigned GET URL; local providers can't
 * reach S3, so `inlineBase64` embeds the bytes as a base64 data URL instead.
 * `expiresIn` is ignored on the base64 path (inlined bytes never expire).
 */
export async function resolveModelImageUrl(
  bucket: string,
  key: string,
  opts: { inlineBase64: boolean; expiresIn?: number }
): Promise<string> {
  return opts.inlineBase64
    ? getS3ObjectAsDataUrl(bucket, key)
    : presignGetUrl(bucket, key, opts.expiresIn);
}

export async function headS3Object(bucket: string, key: string): Promise<{ contentLength: number }> {
  const client = getS3Client();
  const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const len = out.ContentLength ?? 0;
  return { contentLength: len };
}

export async function deleteS3Object(bucket: string, key: string): Promise<void> {
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function listS3Objects(bucket: string, prefix: string): Promise<string[]> {
  const client = getS3Client();
  let isTruncated = true;
  let continuationToken: string | undefined;
  const keys: string[] = [];

  while (isTruncated) {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    if (response.Contents) {
      for (const item of response.Contents) {
        if (item.Key) keys.push(item.Key);
      }
    }

    isTruncated = response.IsTruncated ?? false;
    continuationToken = response.NextContinuationToken;
  }

  return keys;
}

export async function deleteS3Objects(bucket: string, keys: string[]): Promise<void> {
  const client = getS3Client();
  // AWS limits delete batch to 1000 objects.
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await Promise.all(chunk.map((key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))));
  }
}
