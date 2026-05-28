import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
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

export function buildStorageKey(teacherId: string, materialId: string, originalName: string): string {
  const safe = sanitizeFilename(originalName);
  return `learning-materials/${teacherId}/${materialId}/${safe}`;
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

export function getS3Client(): S3Client {
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

export async function headS3Object(bucket: string, key: string): Promise<{ contentLength: number }> {
  const client = getS3Client();
  const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const len = out.ContentLength ?? 0;
  return { contentLength: len };
}

export async function readS3ObjectBytes(bucket: string, key: string): Promise<Buffer> {
  const client = getS3Client();
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = out.Body;
  if (!body) throw new Error("Empty S3 object body");
  return Buffer.from(await body.transformToByteArray());
}

export async function deleteS3Object(bucket: string, key: string): Promise<void> {
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
