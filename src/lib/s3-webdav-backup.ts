import { createHash } from "node:crypto";
import type { WebDAVClient } from "webdav";
import {
  getS3Config,
  getS3KeyPrefix,
  getS3Object,
  listS3Objects,
  putS3Object,
} from "./storage";
import { backupFolder, parseBackupTimestamp, type AppEnv } from "./backup-core";
import {
  ensureDir,
  getClient,
  getFile,
  joinPath,
  putFile,
  removePath,
  type ResolvedWebdavConfig,
} from "./webdav";

const MANIFEST_NAME = "manifest.json";
const MANIFEST_VERSION = 1;

interface S3BackupObject {
  key: string;
  file: string;
  size: number;
  sha256: string;
  contentType: string;
}

interface S3BackupManifest {
  version: typeof MANIFEST_VERSION;
  bucket: string;
  prefix: string;
  createdAt: string;
  objects: S3BackupObject[];
}

export interface S3BackupResult {
  objectCount: number;
  totalBytes: number;
}

function assertBackupName(name: string): void {
  if (!parseBackupTimestamp(name)) throw new Error("Invalid backup name");
}

export function s3BackupFolder(
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
  databaseBackupName: string,
): string {
  assertBackupName(databaseBackupName);
  return joinPath(backupFolder(cfg, env), `${databaseBackupName}.s3`);
}

function manifestPath(
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
  databaseBackupName: string,
): string {
  return joinPath(s3BackupFolder(cfg, env, databaseBackupName), MANIFEST_NAME);
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function objectFile(index: number): string {
  return `objects/${String(index + 1).padStart(8, "0")}.bin`;
}

function validateManifest(value: unknown): S3BackupManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid S3 backup manifest");
  const manifest = value as Partial<S3BackupManifest>;
  if (
    manifest.version !== MANIFEST_VERSION ||
    typeof manifest.bucket !== "string" ||
    typeof manifest.prefix !== "string" ||
    !Array.isArray(manifest.objects)
  ) {
    throw new Error("Invalid S3 backup manifest");
  }

  const seenKeys = new Set<string>();
  const seenFiles = new Set<string>();
  for (const item of manifest.objects) {
    if (
      !item ||
      typeof item.key !== "string" ||
      typeof item.file !== "string" ||
      !/^objects\/\d{8}\.bin$/.test(item.file) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.contentType !== "string" ||
      (manifest.prefix !== "" && !item.key.startsWith(manifest.prefix)) ||
      seenKeys.has(item.key) ||
      seenFiles.has(item.file)
    ) {
      throw new Error("Invalid S3 backup manifest entry");
    }
    seenKeys.add(item.key);
    seenFiles.add(item.file);
  }
  return manifest as S3BackupManifest;
}

/**
 * Copy the current deployment's complete S3 namespace to a companion WebDAV
 * collection. The manifest is uploaded last, so restore/list treat partial
 * uploads as incomplete rather than valid snapshots.
 */
export async function backupS3ToWebdav(
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
  databaseBackupName: string,
): Promise<S3BackupResult> {
  const { bucket } = getS3Config();
  const prefix = getS3KeyPrefix();
  const keys = (await listS3Objects(bucket, prefix)).sort();
  const client = getClient(cfg);
  const folder = s3BackupFolder(cfg, env, databaseBackupName);

  await removePath(client, folder);
  await ensureDir(client, joinPath(folder, "objects"));

  const objects: S3BackupObject[] = [];
  let totalBytes = 0;
  try {
    for (const [index, key] of keys.entries()) {
      const { body, contentType } = await getS3Object(bucket, key);
      const file = objectFile(index);
      await putFile(client, joinPath(folder, file), Buffer.from(body));
      objects.push({ key, file, size: body.byteLength, sha256: sha256(body), contentType });
      totalBytes += body.byteLength;
    }

    const manifest: S3BackupManifest = {
      version: MANIFEST_VERSION,
      bucket,
      prefix,
      createdAt: new Date().toISOString(),
      objects,
    };
    await putFile(
      client,
      joinPath(folder, MANIFEST_NAME),
      Buffer.from(JSON.stringify(manifest), "utf8"),
    );
    return { objectCount: objects.length, totalBytes };
  } catch (error) {
    try {
      await removePath(client, folder);
    } catch {
      // Preserve the copy failure; a later run removes this incomplete folder.
    }
    throw error;
  }
}

/** Read the completed companion manifest for display without downloading objects. */
export async function getS3WebdavBackupSummary(
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
  databaseBackupName: string,
): Promise<S3BackupResult | null> {
  const client = getClient(cfg);
  if (!(await client.exists(manifestPath(cfg, env, databaseBackupName)))) return null;
  const manifest = await readManifest(client, cfg, env, databaseBackupName);
  const totalBytes = manifest.objects.reduce((sum, item) => sum + item.size, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new Error("Invalid S3 backup total size");
  return { objectCount: manifest.objects.length, totalBytes };
}

async function readManifest(
  client: WebDAVClient,
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
  databaseBackupName: string,
): Promise<S3BackupManifest> {
  const raw = await getFile(client, manifestPath(cfg, env, databaseBackupName));
  try {
    return validateManifest(JSON.parse(raw.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Invalid S3 backup manifest JSON");
    throw error;
  }
}

/** Restore a matching S3 snapshot when one accompanies the database backup. */
export async function restoreS3FromWebdav(
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
  databaseBackupName: string,
): Promise<S3BackupResult | null> {
  const client = getClient(cfg);
  if (!(await client.exists(manifestPath(cfg, env, databaseBackupName)))) return null;

  const manifest = await readManifest(client, cfg, env, databaseBackupName);
  const current = getS3Config();
  const currentPrefix = getS3KeyPrefix();
  if (manifest.bucket !== current.bucket || manifest.prefix !== currentPrefix) {
    throw new Error(
      `S3 backup targets ${manifest.bucket}/${manifest.prefix}, but this deployment uses ${current.bucket}/${currentPrefix}`,
    );
  }

  const folder = s3BackupFolder(cfg, env, databaseBackupName);
  let totalBytes = 0;
  for (const item of manifest.objects) {
    const body = await getFile(client, joinPath(folder, item.file));
    if (body.byteLength !== item.size || sha256(body) !== item.sha256) {
      throw new Error(`S3 backup object failed verification: ${item.key}`);
    }
    await putS3Object(manifest.bucket, item.key, body, item.contentType);
    totalBytes += body.byteLength;
  }
  return { objectCount: manifest.objects.length, totalBytes };
}
