import { describe, it, expect, afterEach } from "vitest";
import { encryptApiKey, decryptApiKey, maskApiKey } from "./crypto";

const VALID_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

afterEach(() => {
  // vitest.setup.ts seeds a valid secret; restore it after env-mutating tests.
  process.env.API_KEY_ENCRYPTION_SECRET = VALID_SECRET;
});

describe("encryptApiKey / decryptApiKey", () => {
  it("round-trips a plaintext key", () => {
    const plaintext = "sk-test-abc123";
    const { encrypted, iv, tag } = encryptApiKey(plaintext);
    expect(decryptApiKey(encrypted, iv, tag)).toBe(plaintext);
  });

  it("produces a fresh IV per call (non-deterministic ciphertext)", () => {
    const a = encryptApiKey("same-value");
    const b = encryptApiKey("same-value");
    expect(a.iv).not.toBe(b.iv);
    expect(a.encrypted).not.toBe(b.encrypted);
  });

  it("fails to decrypt when the auth tag is tampered with", () => {
    const { encrypted, iv } = encryptApiKey("secret");
    const badTag = "00000000000000000000000000000000";
    expect(() => decryptApiKey(encrypted, iv, badTag)).toThrow();
  });

  it("throws a clear error when the secret is missing", () => {
    delete process.env.API_KEY_ENCRYPTION_SECRET;
    expect(() => encryptApiKey("x")).toThrow(/API_KEY_ENCRYPTION_SECRET/);
  });

  it("throws when the secret is not 32 bytes", () => {
    process.env.API_KEY_ENCRYPTION_SECRET = "abcd"; // 2 bytes
    expect(() => encryptApiKey("x")).toThrow(/64 hex characters/);
  });
});

describe("maskApiKey", () => {
  it("shows only the last 4 characters", () => {
    expect(maskApiKey("sk-1234567890")).toBe("••••7890");
  });

  it("masks entirely when the key is 4 chars or shorter", () => {
    expect(maskApiKey("abcd")).toBe("••••");
    expect(maskApiKey("a")).toBe("••••");
  });
});
