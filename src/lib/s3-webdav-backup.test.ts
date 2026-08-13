import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getS3Config: vi.fn(() => ({ bucket: "documents", region: "us-east-1" })),
  getS3KeyPrefix: vi.fn(() => "dev/"),
  listS3Objects: vi.fn(),
  getS3Object: vi.fn(),
  putS3Object: vi.fn(),
  ensureDir: vi.fn(),
  putFile: vi.fn(),
  getFile: vi.fn(),
  removePath: vi.fn(),
  exists: vi.fn(),
}));

vi.mock("./storage", () => ({
  getS3Config: mocks.getS3Config,
  getS3KeyPrefix: mocks.getS3KeyPrefix,
  listS3Objects: mocks.listS3Objects,
  getS3Object: mocks.getS3Object,
  putS3Object: mocks.putS3Object,
}));

vi.mock("./webdav", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webdav")>();
  return {
    ...actual,
    getClient: vi.fn(() => ({ exists: mocks.exists })),
    ensureDir: mocks.ensureDir,
    putFile: mocks.putFile,
    getFile: mocks.getFile,
    removePath: mocks.removePath,
  };
});

import {
  backupS3ToWebdav,
  hasS3WebdavBackup,
  restoreS3FromWebdav,
} from "./s3-webdav-backup";
import type { ResolvedWebdavConfig } from "./webdav";

const webdav: ResolvedWebdavConfig = {
  url: "https://dav.example",
  username: "user",
  password: "pass",
  baseDir: "/backups",
};
const backupName = "backup-20260813T120000Z.db.gz";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getS3Config.mockReturnValue({ bucket: "documents", region: "us-east-1" });
  mocks.getS3KeyPrefix.mockReturnValue("dev/");
});

describe("backupS3ToWebdav", () => {
  it("copies every namespaced object and publishes the manifest last", async () => {
    mocks.listS3Objects.mockResolvedValue(["dev/z.pdf", "dev/a.png"]);
    mocks.getS3Object.mockImplementation(async (_bucket: string, key: string) => ({
      body: Buffer.from(key),
      contentType: key.endsWith(".pdf") ? "application/pdf" : "image/png",
    }));

    const result = await backupS3ToWebdav(webdav, "dev", backupName);

    expect(result).toEqual({
      objectCount: 2,
      totalBytes: Buffer.byteLength("dev/a.png") + Buffer.byteLength("dev/z.pdf"),
    });
    expect(mocks.getS3Object.mock.calls.map((call) => call[1])).toEqual([
      "dev/a.png",
      "dev/z.pdf",
    ]);
    expect(mocks.putFile).toHaveBeenCalledTimes(3);

    const [, manifestPath, manifestBytes] = mocks.putFile.mock.calls.at(-1)!;
    expect(manifestPath).toBe(`/backups/dev/${backupName}.s3/manifest.json`);
    const manifest = JSON.parse((manifestBytes as Buffer).toString("utf8"));
    expect(manifest).toMatchObject({ version: 1, bucket: "documents", prefix: "dev/" });
    expect(manifest.objects.map((item: { key: string }) => item.key)).toEqual([
      "dev/a.png",
      "dev/z.pdf",
    ]);
  });

  it("removes a partial companion when an object copy fails", async () => {
    mocks.listS3Objects.mockResolvedValue(["dev/missing.pdf"]);
    mocks.getS3Object.mockRejectedValue(new Error("gone"));

    await expect(backupS3ToWebdav(webdav, "dev", backupName)).rejects.toThrow("gone");
    expect(mocks.removePath).toHaveBeenLastCalledWith(
      expect.anything(),
      `/backups/dev/${backupName}.s3`,
    );
  });
});

describe("restoreS3FromWebdav", () => {
  it("returns null for database-only backups", async () => {
    mocks.exists.mockResolvedValue(false);
    await expect(restoreS3FromWebdav(webdav, "dev", backupName)).resolves.toBeNull();
  });

  it("verifies and restores objects through the matching database restore", async () => {
    const body = Buffer.from("document bytes");
    const manifest = {
      version: 1,
      bucket: "documents",
      prefix: "dev/",
      createdAt: "2026-08-13T12:00:00.000Z",
      objects: [
        {
          key: "dev/learning-materials/document.pdf",
          file: "objects/00000001.bin",
          size: body.byteLength,
          sha256: "0d6f2e630f794b4b2d5a4d2466e0c23f9d6b587967b5895c9c8ad1f0eda93364",
          contentType: "application/pdf",
        },
      ],
    };
    // Use the implementation's checksum rather than a hand-maintained fixture.
    const { createHash } = await import("node:crypto");
    manifest.objects[0].sha256 = createHash("sha256").update(body).digest("hex");
    mocks.exists.mockResolvedValue(true);
    mocks.getFile
      .mockResolvedValueOnce(Buffer.from(JSON.stringify(manifest)))
      .mockResolvedValueOnce(body);

    await expect(restoreS3FromWebdav(webdav, "dev", backupName)).resolves.toEqual({
      objectCount: 1,
      totalBytes: body.byteLength,
    });
    expect(mocks.putS3Object).toHaveBeenCalledWith(
      "documents",
      "dev/learning-materials/document.pdf",
      body,
      "application/pdf",
    );
  });

  it("refuses to restore a snapshot from another bucket or deployment prefix", async () => {
    mocks.exists.mockResolvedValue(true);
    mocks.getFile.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          version: 1,
          bucket: "production-documents",
          prefix: "prod/",
          createdAt: "2026-08-13T12:00:00.000Z",
          objects: [],
        }),
      ),
    );

    await expect(restoreS3FromWebdav(webdav, "dev", backupName)).rejects.toThrow(
      /this deployment uses/,
    );
    expect(mocks.putS3Object).not.toHaveBeenCalled();
  });
});

describe("hasS3WebdavBackup", () => {
  it("uses the completed manifest as the presence marker", async () => {
    mocks.exists.mockResolvedValue(true);
    await expect(hasS3WebdavBackup(webdav, "dev", backupName)).resolves.toBe(true);
    expect(mocks.exists).toHaveBeenCalledWith(`/backups/dev/${backupName}.s3/manifest.json`);
  });
});
