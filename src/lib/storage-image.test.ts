import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the AWS SDK so these specs stay pure (no network / no real S3). The
// mocked S3Client.send is driven per-test; GetObjectCommand just captures its
// input so the presigner mock can echo the requested Key back as a fake URL.
const sendMock = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class FakeCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = sendMock;
    },
    GetObjectCommand: FakeCommand,
    PutObjectCommand: FakeCommand,
    HeadObjectCommand: FakeCommand,
    DeleteObjectCommand: FakeCommand,
    ListObjectsV2Command: FakeCommand,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(
    async (_client: unknown, cmd: { input: { Key: string } }) =>
      `https://signed.example/${cmd.input.Key}`,
  ),
}));

import { getS3ObjectAsDataUrl, resolveModelImageUrl } from "./storage";

beforeEach(() => {
  sendMock.mockReset();
});

describe("getS3ObjectAsDataUrl", () => {
  it("returns a base64 data URL using the object's stored content type", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    sendMock.mockResolvedValue({
      Body: { transformToByteArray: async () => bytes },
      ContentType: "image/jpeg",
    });

    const url = await getS3ObjectAsDataUrl("bucket", "k.jpg");

    expect(url).toBe(
      `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
    );
  });

  it("defaults the MIME type to image/png when none is stored", async () => {
    sendMock.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });

    const url = await getS3ObjectAsDataUrl("bucket", "page-1.png");

    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("throws when the object has no body", async () => {
    sendMock.mockResolvedValue({});
    await expect(getS3ObjectAsDataUrl("bucket", "missing")).rejects.toThrow(
      /no body/i,
    );
  });
});

describe("resolveModelImageUrl", () => {
  it("inlines bytes as base64 for local providers (inlineBase64: true)", async () => {
    sendMock.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([0xff]) },
      ContentType: "image/png",
    });

    const url = await resolveModelImageUrl("bucket", "page-1.png", {
      inlineBase64: true,
    });

    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1); // fetched the object
  });

  it("hands hosted providers a presigned GET URL (inlineBase64: false)", async () => {
    const url = await resolveModelImageUrl("bucket", "page-2.png", {
      inlineBase64: false,
      expiresIn: 3600,
    });

    expect(url).toBe("https://signed.example/page-2.png");
    expect(sendMock).not.toHaveBeenCalled(); // no object download on the presign path
  });
});
