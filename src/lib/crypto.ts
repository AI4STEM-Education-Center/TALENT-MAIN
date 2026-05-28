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
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  const keyBuffer = Buffer.from(secret, "hex");
  if (keyBuffer.length !== 32) {
    throw new Error(
      "API_KEY_ENCRYPTION_SECRET must be exactly 64 hex characters (32 bytes). " +
        `Got ${secret.length} hex characters (${keyBuffer.length} bytes).`
    );
  }

  return keyBuffer;
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
  tag: string
): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Mask an API key for display — shows only the last 4 characters.
 * Returns "••••" if the key is too short.
 */
export function maskApiKey(key: string): string {
  if (key.length <= 4) return "••••";
  return "••••" + key.slice(-4);
}
