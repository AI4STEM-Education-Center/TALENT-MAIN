import type { LearningMaterial } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { headS3Object, readS3ObjectBytes } from "@/lib/storage";

/** Resolved S3 location for pipelines or LLM tooling (fetch bytes with readLearningMaterialBytes). */
export type LearningMaterialLocation = {
  provider: "S3";
  bucket: string;
  key: string;
  materialId: string;
};

export function materialToLocation(m: LearningMaterial): LearningMaterialLocation {
  return {
    provider: "S3",
    bucket: m.bucket,
    key: m.storageKey,
    materialId: m.id,
  };
}

/** Load a record; use when parsing or processing by id from the database. */
export async function getLearningMaterialById(materialId: string): Promise<LearningMaterial | null> {
  return prisma.learningMaterial.findUnique({ where: { id: materialId } });
}

export async function deleteLearningMaterialById(materialId: string): Promise<void> {
  await prisma.learningMaterial.delete({ where: { id: materialId } });
}

export async function resolveLearningMaterialLocation(
  materialId: string
): Promise<{ material: LearningMaterial; location: LearningMaterialLocation } | null> {
  const material = await getLearningMaterialById(materialId);
  if (!material || material.uploadStatus !== "READY") return null;
  return { material, location: materialToLocation(material) };
}

/** Read full file bytes for LLM ingestion or parsing (from S3). */
export async function readLearningMaterialBytes(materialId: string): Promise<Buffer> {
  const material = await getLearningMaterialById(materialId);
  if (!material) throw new Error(`Learning material not found: ${materialId}`);
  if (material.uploadStatus !== "READY") {
    throw new Error(`Learning material not ready: ${materialId} (${material.uploadStatus})`);
  }
  return readS3ObjectBytes(material.bucket, material.storageKey);
}

/** Verify S3 object exists and size matches after upload (server-side). */
export async function verifyS3UploadComplete(
  bucket: string,
  key: string,
  expectedBytes: number
): Promise<boolean> {
  const { contentLength } = await headS3Object(bucket, key);
  return contentLength === expectedBytes;
}
