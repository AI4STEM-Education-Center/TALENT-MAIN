import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { TEST_AWS_ENV } from "../../vitest.setup";

// The CloudFront signer is exercised for real (it is pure crypto, no network),
// but the S3 SDK is stubbed so the fallback path can be recognised by its URL
// without touching AWS. getSignedUrl echoes the requested Key back.
vi.mock("@aws-sdk/client-s3", () => {
  class FakeCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = vi.fn();
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
    async (_client: unknown, cmd: { input: { Bucket: string; Key: string } }) =>
      `https://s3.example/${cmd.input.Bucket}/${cmd.input.Key}`
  ),
}));

// A throwaway 2048-bit key, generated per run rather than committed: a private
// key checked into the repo is the exact mistake docs/SETUP.md warns against.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const ORIGIN_BUCKET = "cdn-origin-bucket";

/**
 * getCloudFrontConfig() and the S3 client are module-level singletons, so each
 * case needs a fresh module registry to pick up different environment values.
 */
async function loadStorage() {
  vi.resetModules();
  return import("./storage");
}

function configureCloudFront(overrides: Record<string, string | undefined> = {}) {
  process.env.AWS_S3_BUCKET = ORIGIN_BUCKET;
  process.env.CLOUDFRONT_DOMAIN = "cdn.example.org";
  process.env.CLOUDFRONT_KEY_PAIR_ID = "K2JCJMDEHXQW5F";
  process.env.CLOUDFRONT_PRIVATE_KEY = Buffer.from(PEM).toString("base64");
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  delete process.env.CLOUDFRONT_DOMAIN;
  delete process.env.CLOUDFRONT_KEY_PAIR_ID;
  delete process.env.CLOUDFRONT_PRIVATE_KEY;
});

afterEach(() => {
  delete process.env.CLOUDFRONT_DOMAIN;
  delete process.env.CLOUDFRONT_KEY_PAIR_ID;
  delete process.env.CLOUDFRONT_PRIVATE_KEY;
  Object.assign(process.env, TEST_AWS_ENV);
});

describe("getCloudFrontConfig", () => {
  it("returns null when none of the three variables are set", async () => {
    const { getCloudFrontConfig } = await loadStorage();
    expect(getCloudFrontConfig()).toBeNull();
  });

  // A half-configured CDN cannot sign anything, and silently serving from S3
  // would hide the mistake until someone noticed the CDN was doing nothing.
  it("throws when only some of the three variables are set", async () => {
    configureCloudFront({ CLOUDFRONT_PRIVATE_KEY: undefined });
    const { getCloudFrontConfig } = await loadStorage();
    expect(() => getCloudFrontConfig()).toThrow(/CLOUDFRONT_DOMAIN/);
  });

  it("strips a scheme and trailing slash from the domain", async () => {
    configureCloudFront({ CLOUDFRONT_DOMAIN: "https://cdn.example.org/" });
    const { getCloudFrontConfig } = await loadStorage();
    expect(getCloudFrontConfig()?.domain).toBe("cdn.example.org");
  });

  it("decodes a base64-encoded private key", async () => {
    configureCloudFront();
    const { getCloudFrontConfig } = await loadStorage();
    expect(getCloudFrontConfig()?.privateKey).toBe(PEM);
  });

  // The other common single-line convention for a PEM in a .env file.
  it("restores newlines in a PEM carrying literal \\n escapes", async () => {
    configureCloudFront({ CLOUDFRONT_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") });
    const { getCloudFrontConfig } = await loadStorage();
    expect(getCloudFrontConfig()?.privateKey.trimEnd()).toBe(PEM.trimEnd());
  });
});

describe("signObjectReadUrl", () => {
  it("presigns against S3 when CloudFront is not configured", async () => {
    const { signObjectReadUrl } = await loadStorage();
    const url = await signObjectReadUrl(TEST_AWS_ENV.AWS_S3_BUCKET, "dev/pages/page-1.png");
    expect(url).toBe(`https://s3.example/${TEST_AWS_ENV.AWS_S3_BUCKET}/dev/pages/page-1.png`);
  });

  it("signs a CloudFront URL for objects in the distribution's origin bucket", async () => {
    configureCloudFront();
    const { signObjectReadUrl } = await loadStorage();

    const url = new URL(await signObjectReadUrl(ORIGIN_BUCKET, "prod/pages/page-1.png"));

    expect(url.host).toBe("cdn.example.org");
    expect(url.pathname).toBe("/prod/pages/page-1.png");
    expect(url.searchParams.get("Key-Pair-Id")).toBe("K2JCJMDEHXQW5F");
    expect(url.searchParams.get("Signature")).toBeTruthy();
    expect(Number(url.searchParams.get("Expires"))).toBeGreaterThan(Date.now() / 1000);
  });

  it("honours the expiry window in the signed URL", async () => {
    configureCloudFront();
    const { signObjectReadUrl } = await loadStorage();

    const before = Math.floor(Date.now() / 1000);
    const url = new URL(await signObjectReadUrl(ORIGIN_BUCKET, "prod/figure-0.png", 60));
    const expires = Number(url.searchParams.get("Expires"));

    expect(expires).toBeGreaterThanOrEqual(before + 59);
    expect(expires).toBeLessThanOrEqual(before + 62);
  });

  // Rows carry their own `bucket` column, so historical objects may sit in a
  // bucket that was never placed behind the distribution. Those must keep
  // resolving instead of being signed for a host that cannot serve them.
  it("falls back to S3 for an object in a bucket that is not the CDN origin", async () => {
    configureCloudFront();
    const { signObjectReadUrl } = await loadStorage();

    const url = await signObjectReadUrl("legacy-bucket", "prod/pages/page-1.png");

    expect(url).toBe("https://s3.example/legacy-bucket/prod/pages/page-1.png");
  });

  it("percent-encodes path segments without escaping the separators", async () => {
    configureCloudFront();
    const { signObjectReadUrl } = await loadStorage();

    const url = new URL(
      await signObjectReadUrl(ORIGIN_BUCKET, "prod/learning-materials/t1/my file.pdf")
    );

    expect(url.pathname).toBe("/prod/learning-materials/t1/my%20file.pdf");
  });
});
