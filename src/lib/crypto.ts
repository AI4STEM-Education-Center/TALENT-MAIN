import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/**
 * Returns the 32-byte encryption key derived from the API_KEY_ENCRYPTION_SECRET env var.
 * Throws a clear error if the env var is missing or invalid.
 */
function getEncryptionKey(): Buffer {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "API_KEY_ENCRYPTION_SECRET environment variable is required for API key encryption. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  const keyBuffer = Buffer.from(secret, "hex");
  if (keyBuffer.length !== 32) {
    throw new Error(
      "API_KEY_ENCRYPTION_SECRET must be exactly 64 hex characters (32 bytes). " +
        `Got ${secret.length} hex characters (${keyBuffer.length} bytes).`,
    );
  }

  return keyBuffer;
}

/**
 * Keys to TRY when decrypting, newest first: the active key, then any retired
 * keys listed in API_KEY_ENCRYPTION_SECRET_OLD (comma-separated 64-hex values).
 *
 * This is the key-rotation path: to rotate, move the current secret into
 * API_KEY_ENCRYPTION_SECRET_OLD, set a fresh API_KEY_ENCRYPTION_SECRET, then
 * re-encrypt stored secrets (load + save each provider/SMTP/WebDAV record so it
 * is re-written under the new key). Once nothing decrypts under the old key,
 * drop it from API_KEY_ENCRYPTION_SECRET_OLD. New writes always use the active
 * key; old ciphertext keeps decrypting until re-encrypted.
 */
function getDecryptionKeys(): Buffer[] {
  const keys = [getEncryptionKey()];
  const retired = process.env.API_KEY_ENCRYPTION_SECRET_OLD;
  if (retired) {
    for (const hex of retired
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const buf = Buffer.from(hex, "hex");
      if (buf.length === 32) keys.push(buf);
    }
  }
  return keys;
}

/**
 * Encrypt a plaintext API key using AES-256-GCM.
 * Returns the encrypted value, IV, and auth tag as hex strings.
 */
export function encryptApiKey(plaintext: string): {
  encrypted: string;
  iv: string;
  tag: string;
} {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

/**
 * Decrypt an API key that was encrypted with encryptApiKey.
 * Returns the plaintext API key.
 */
export function decryptApiKey(
  encrypted: string,
  iv: string,
  tag: string,
): string {
  // Try the active key first, then any retired keys, so ciphertext written
  // under a previous key still decrypts during/after a key rotation.
  const ivBuf = Buffer.from(iv, "hex");
  const tagBuf = Buffer.from(tag, "hex");
  let lastError: unknown;

  for (const key of getDecryptionKeys()) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf);
      decipher.setAuthTag(tagBuf);
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("Failed to decrypt: no usable key.");
}

/**
 * Mask an API key for display — shows only the last 4 characters.
 * Returns "••••" if the key is too short.
 */
export function maskApiKey(key: string): string {
  if (key.length <= 4) return "••••";
  return "••••" + key.slice(-4);
}
