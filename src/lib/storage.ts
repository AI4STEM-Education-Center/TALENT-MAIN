import {
  LEGACY_PAGE_IMAGE_EXTENSION,
  type PageImageExtension,
} from "./page-image-format";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
// Both packages export `getSignedUrl` with different signatures, so each import
// is aliased to the delivery path it belongs to.
import { getSignedUrl as getS3PresignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const PRESIGN_EXPIRES_SEC = 3600;

/**
 * Optional namespace for every object this deployment creates. The compose
 * stacks use `prod/` and `dev/` so their independent databases and garbage
 * collectors can safely share the same bucket. An empty prefix remains the
 * local/backward-compatible default for previously stored full keys.
 */
export function getS3KeyPrefix(): string {
  const raw = process.env.S3_KEY_PREFIX?.trim();
  if (!raw) return "";

  const segments = raw.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || !/^[a-zA-Z0-9._-]+$/.test(segment)
    )
  ) {
    throw new Error("S3_KEY_PREFIX must contain only safe path segments");
  }
  return `${segments.join("/")}/`;
}

function prefixedS3Key(key: string): string {
  return `${getS3KeyPrefix()}${key}`;
}

export function getMaxUploadBytes(): number {
  const raw = process.env.LEARNING_MATERIAL_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/**
 * Legacy flat allowance for a document's rendered page images: four times the
 * single-file limit, whatever the page count. Retained only as a floor below,
 * so nothing that used to upload starts failing.
 */
const DERIVED_BYTES_MULTIPLIER = 4;
/** Per-page allowance once a document is long enough for the flat cap to bind. */
const PER_PAGE_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * Total bytes allowed across a document's rendered page images.
 *
 * `getMaxUploadBytes()` bounds ONE object, so a flat multiple of it is the same
 * budget for a 3-page handout and a 100-page scan. Scanned pages compress badly
 * as PNG, so a long document blows the flat 4x allowance while every individual
 * page is comfortably legal — and it only finds out at completion, after every
 * page has already been uploaded. Scaling with the page count fixes that; the
 * flat value stays as a floor so short documents keep the allowance they had.
 */
export function maxDerivedPageBytes(pageCount: number): number {
  return Math.max(
    getMaxUploadBytes() * DERIVED_BYTES_MULTIPLIER,
    pageCount * PER_PAGE_BUDGET_BYTES
  );
}

export function sanitizeFilename(name: string): string {
  const base = name.replace(/^.*[/\\]/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.slice(0, 200) || "file";
}

export function buildStorageKey(teacherId: string, classId: string, materialId: string, originalName: string): string {
  const safe = sanitizeFilename(originalName);
  return prefixedS3Key(`learning-materials/${teacherId}/${classId}/${materialId}/${safe}`);
}

/**
 * Deterministic key for one rendered page. `extension` is negotiated with the
 * client at presign time (see src/lib/page-image-format.ts) and defaults to the
 * legacy `png` so a caller that never negotiated gets the key it always got.
 */
export function buildPageStorageKey(
  teacherId: string,
  classId: string,
  materialId: string,
  pageNumber: number,
  extension: PageImageExtension = LEGACY_PAGE_IMAGE_EXTENSION
): string {
  return prefixedS3Key(
    `learning-materials/${teacherId}/${classId}/${materialId}/pages/page-${pageNumber}.${extension}`
  );
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
  return prefixedS3Key(
    `quiz-extractions/${quizExtractionScope(teacherId)}/${quizId}/${extractionId}/${safe}`
  );
}

export function buildQuizExtractionPageKey(
  teacherId: string | null,
  quizId: string,
  extractionId: string,
  pageNumber: number,
  extension: PageImageExtension = LEGACY_PAGE_IMAGE_EXTENSION
): string {
  return prefixedS3Key(
    `quiz-extractions/${quizExtractionScope(teacherId)}/${quizId}/${extractionId}/pages/page-${pageNumber}.${extension}`
  );
}

export function buildQuizExtractionFigureKey(
  teacherId: string | null,
  quizId: string,
  extractionId: string,
  questionIndex: number,
  extension: PageImageExtension = LEGACY_PAGE_IMAGE_EXTENSION
): string {
  return prefixedS3Key(
    `quiz-extractions/${quizExtractionScope(teacherId)}/${quizId}/${extractionId}/figures/figure-${questionIndex}.${extension}`
  );
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
  optionIndex: number,
  extension: PageImageExtension = LEGACY_PAGE_IMAGE_EXTENSION
): string {
  return prefixedS3Key(
    `quiz-extractions/${quizExtractionScope(teacherId)}/${quizId}/${extractionId}/figures/option-${questionIndex}-${optionIndex}.${extension}`
  );
}

/** Prefix covering every object of one extraction (PDF, pages, figures). */
export function quizExtractionPrefix(pdfStorageKey: string): string {
  return pdfStorageKey.slice(0, pdfStorageKey.lastIndexOf("/") + 1);
}

// ─── Question simulation keys ─────────────────────────────────────────────────
// Same scope convention as quiz extractions: pool questions live under "pool".
// Every (re)generation writes a NEW version — objects are immutable because
// deep-copied questions share simulation keys the way they share figure keys,
// so an in-place overwrite would silently change someone else's copy.

export function buildSimulationKey(
  teacherId: string | null,
  quizId: string,
  questionId: string,
  version: number
): string {
  return prefixedS3Key(
    `simulations/${quizExtractionScope(teacherId)}/${quizId}/${questionId}/v${version}.html`
  );
}

/** Key for one bulk admin consent-record export job's zip archive. */
export function buildConsentExportKey(jobId: string): string {
  return prefixedS3Key(`consent-exports/${jobId}/export.zip`);
}

/**
 * Key for one chat-assistant attachment. Scoped by user so a bucket listing is
 * readable, and by attachment id so the original filename can never collide
 * with another upload of the same name.
 */
export function buildAssistantAttachmentKey(
  userId: string,
  attachmentId: string,
  originalName: string
): string {
  return prefixedS3Key(
    `assistant-attachments/${userId}/${attachmentId}/${sanitizeFilename(originalName)}`
  );
}

/**
 * Where an archived chat transcript lives. One newline-delimited JSON object per
 * conversation, written once when it ages out of its owner's history window and
 * then read only by admins — so the key is derived from the conversation id
 * alone, making the archive write idempotent if a sweep is retried.
 *
 * Kept UNCOMPRESSED on purpose: a transcript is small next to the images in the
 * neighbouring `assistant-attachments/` prefix, and a plain-text object is one
 * an admin can read straight out of the bucket if the app is unavailable.
 */
export function buildAssistantTranscriptKey(userId: string, conversationId: string): string {
  return prefixedS3Key(`assistant-transcripts/${userId}/${conversationId}.jsonl`);
}

export function getS3Config(): { bucket: string; region: string } {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) {
    throw new Error("Learning materials require AWS_S3_BUCKET and AWS_REGION");
  }
  return { bucket, region };
}

/**
 * Static credentials, read straight from the environment. Deliberately NOT the
 * AWS SDK's default provider chain: passing no `credentials` let the SDK fall
 * through to the EC2 instance metadata service, so which identity a deployment
 * used silently depended on the host it happened to run on. Requiring the keys
 * here means a misconfigured `.env` fails with this message instead of
 * half-working. `AWS_SESSION_TOKEN` is optional and only set for temporary STS
 * credentials.
 */
export function getAwsCredentials(): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3 access requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment (IAM instance roles are not used)"
    );
  }
  const sessionToken = process.env.AWS_SESSION_TOKEN?.trim();
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

let s3Client: S3Client | null = null;

/**
 * Exported (unlike the rest of this module's private helpers) so
 * src/lib/consent-export.ts can hand the same configured client to
 * @aws-sdk/lib-storage's `Upload` for streaming the bulk consent-PDF zip
 * directly to S3, without duplicating the endpoint/region setup here.
 */
export function getS3Client(): S3Client {
  if (!s3Client) {
    const endpoint = process.env.AWS_S3_ENDPOINT;
    // Region comes from getS3Config() rather than a second process.env read so
    // the client can never be built with `region: undefined` while the config
    // check would have rejected the same environment.
    s3Client = new S3Client({
      region: getS3Config().region,
      credentials: getAwsCredentials(),
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

// ─── CloudFront delivery ──────────────────────────────────────────────────────
// Images and PDFs are read through a CloudFront distribution whose origin is the
// private bucket (Origin Access Control), using signed URLs so objects stay
// non-public. Uploads are unaffected: they remain presigned S3 PUTs straight to
// the bucket, because a CDN adds nothing to writes.

export type CloudFrontConfig = { domain: string; keyPairId: string; privateKey: string };

/**
 * A `.env` consumed by Docker Compose's `env_file:` cannot hold real newlines,
 * so the PEM arrives in one of two single-line forms. Base64 is the documented
 * recommendation (no shell-special characters); a PEM with literal `\n` escape
 * sequences is accepted too, since that is the other common convention.
 */
function normalizeCloudFrontPrivateKey(raw: string): string {
  if (raw.includes("BEGIN")) return raw.replace(/\\n/g, "\n");
  return Buffer.from(raw, "base64").toString("utf8");
}

/** Accepts `d111.cloudfront.net`, `https://cdn.example.org`, or a trailing slash. */
function normalizeCloudFrontDomain(raw: string): string {
  return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

let cloudFrontConfig: CloudFrontConfig | null | undefined;

/**
 * Resolved CloudFront settings, or null when the CDN is not configured — local
 * dev and MinIO/LocalStack setups serve from S3 directly. A PARTIAL
 * configuration throws instead of falling back: signing cannot work without all
 * three values, and silently serving from S3 would hide the mistake until
 * someone noticed the CDN was doing nothing.
 */
export function getCloudFrontConfig(): CloudFrontConfig | null {
  if (cloudFrontConfig !== undefined) return cloudFrontConfig;

  const domain = process.env.CLOUDFRONT_DOMAIN?.trim();
  const keyPairId = process.env.CLOUDFRONT_KEY_PAIR_ID?.trim();
  const privateKey = process.env.CLOUDFRONT_PRIVATE_KEY?.trim();

  if (!domain && !keyPairId && !privateKey) {
    cloudFrontConfig = null;
    return cloudFrontConfig;
  }
  if (!domain || !keyPairId || !privateKey) {
    throw new Error(
      "CloudFront delivery needs CLOUDFRONT_DOMAIN, CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_PRIVATE_KEY together (leave all three empty to serve from S3)"
    );
  }

  cloudFrontConfig = {
    domain: normalizeCloudFrontDomain(domain),
    keyPairId,
    privateKey: normalizeCloudFrontPrivateKey(privateKey),
  };
  return cloudFrontConfig;
}

/**
 * Percent-encode each path segment without escaping the `/` separators. Storage
 * keys are built from `sanitizeFilename`, so they are already URL-safe, but the
 * URL is not worth assembling by raw concatenation.
 */
function encodeS3KeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
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
    // Upload keys are immutable. This prevents a still-valid presigned URL
    // from replacing an object after the completion endpoint HEADs it.
    IfNoneMatch: "*",
  });
  return getS3PresignedUrl(client, cmd, { expiresIn: PRESIGN_EXPIRES_SEC });
}

/**
 * Signed, time-limited read URL for a stored object — the single entry point for
 * every image and PDF the browser or a hosted model fetches.
 *
 * Routes through CloudFront when the CDN is configured AND the object lives in
 * the distribution's origin bucket. The bucket is checked because rows carry
 * their own `bucket` column (LearningMaterial, QuizPdfExtraction,
 * Question.figureBucket, Option.imageBucket), so historical rows may name a
 * bucket that is not behind the CDN; those must keep resolving. Everything else
 * falls back to a presigned S3 GET, which is also the rollback path: clear the
 * CLOUDFRONT_* variables and delivery returns to S3 with no code change.
 *
 * Signed CloudFront URLs are fetchable by any client, so the hosted-model
 * consumers in vlm-engine / quiz-extraction-engine work unchanged.
 */
export async function signObjectReadUrl(
  bucket: string,
  key: string,
  expiresIn = PRESIGN_EXPIRES_SEC
): Promise<string> {
  const cloudFront = getCloudFrontConfig();
  if (cloudFront && bucket === getS3Config().bucket) {
    return getCloudFrontSignedUrl({
      url: `https://${cloudFront.domain}/${encodeS3KeyPath(key)}`,
      keyPairId: cloudFront.keyPairId,
      privateKey: cloudFront.privateKey,
      dateLessThan: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  }

  const client = getS3Client();
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getS3PresignedUrl(client, cmd, { expiresIn });
}

/**
 * Preserve direct S3 delivery for generated archives that are not part of the
 * CloudFront image/PDF origin contract (for example bulk consent exports).
 */
export async function presignGetUrl(
  bucket: string,
  key: string,
  expiresIn = PRESIGN_EXPIRES_SEC
): Promise<string> {
  const client = getS3Client();
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getS3PresignedUrl(client, cmd, { expiresIn });
}

/**
 * Download an S3 object and return it as a base64 `data:` URL, the form an
 * OpenAI-compatible `image_url` part accepts inline. Used for local model
 * providers (Ollama / vLLM / LM Studio / …) which typically can't reach our
 * presigned S3 URLs over the network, so the image bytes are embedded directly
 * in the chat-completions request instead of linked. The MIME type comes from
 * the object's stored Content-Type, defaulting to image/png for objects
 * written before Content-Type was recorded (pages and crops are WebP now, but
 * S3 hands back whatever each object was stored with).
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
 * over HTTP, so they get a short-lived signed read URL (CloudFront or S3, see
 * `signObjectReadUrl`); local providers can't reach either, so `inlineBase64`
 * embeds the bytes as a base64 data URL instead. `expiresIn` is ignored on the
 * base64 path (inlined bytes never expire).
 */
export async function resolveModelImageUrl(
  bucket: string,
  key: string,
  opts: { inlineBase64: boolean; expiresIn?: number }
): Promise<string> {
  return opts.inlineBase64
    ? getS3ObjectAsDataUrl(bucket, key)
    : signObjectReadUrl(bucket, key, opts.expiresIn);
}

/**
 * Upload a server-generated object directly (no presign round-trip). Used by
 * the background worker for simulation HTML artifacts.
 */
export async function putS3Object(
  bucket: string,
  key: string,
  body: string | Uint8Array,
  contentType: string
): Promise<void> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
  );
}

/** Copy an immutable object inside a bucket without downloading it. */
export async function copyS3Object(bucket: string, sourceKey: string, targetKey: string): Promise<void> {
  const client = getS3Client();
  const copySource = `${bucket}/${sourceKey}`
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  await client.send(
    new CopyObjectCommand({ Bucket: bucket, CopySource: copySource, Key: targetKey })
  );
}

/** Download an S3 object and decode it as UTF-8 text (simulation HTML artifacts). */
export async function getS3ObjectAsString(bucket: string, key: string): Promise<string> {
  const client = getS3Client();
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`S3 object ${key} has no body`);
  return out.Body.transformToString("utf-8");
}

/** Download an S3 object for WebDAV backup while preserving its content type. */
export async function getS3Object(
  bucket: string,
  key: string
): Promise<{ body: Uint8Array; contentType: string }> {
  const client = getS3Client();
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`S3 object ${key} has no body`);
  return {
    body: await out.Body.transformToByteArray(),
    contentType: out.ContentType || "application/octet-stream",
  };
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

/**
 * Total bytes stored under a key prefix, plus the object count.
 *
 * Used by the admin resource monitor to report an environment's S3 footprint.
 * Because compose pins prod to `prod/` and dev to `dev/`, passing this
 * deployment's own getS3KeyPrefix() yields that environment's usage alone even
 * though both share one bucket. S3 has no cheap "size of prefix" API, so this
 * is a full paginated listing — call it on a slow cadence (the worker refreshes
 * hourly), never per request.
 */
export async function sumS3PrefixBytes(
  bucket: string,
  prefix: string
): Promise<{ bytes: number; objects: number }> {
  const client = getS3Client();
  let isTruncated = true;
  let continuationToken: string | undefined;
  let bytes = 0;
  let objects = 0;

  while (isTruncated) {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const item of response.Contents ?? []) {
      bytes += item.Size ?? 0;
      objects += 1;
    }

    isTruncated = response.IsTruncated ?? false;
    continuationToken = response.NextContinuationToken;
  }

  return { bytes, objects };
}

export type S3ObjectMeta = { key: string; lastModified: Date | null };

/**
 * Like listS3Objects but keeps each object's LastModified, which the S3
 * garbage collector needs to grant a grace period to freshly-written objects
 * (their DB reference may not be committed yet).
 */
export async function listS3ObjectsWithMeta(bucket: string, prefix: string): Promise<S3ObjectMeta[]> {
  const client = getS3Client();
  let isTruncated = true;
  let continuationToken: string | undefined;
  const objects: S3ObjectMeta[] = [];

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
        if (item.Key) objects.push({ key: item.Key, lastModified: item.LastModified ?? null });
      }
    }

    isTruncated = response.IsTruncated ?? false;
    continuationToken = response.NextContinuationToken;
  }

  return objects;
}

export async function deleteS3Objects(bucket: string, keys: string[]): Promise<void> {
  const client = getS3Client();
  // AWS limits delete batch to 1000 objects.
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await Promise.all(chunk.map((key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))));
  }
}
