import { createHash } from "node:crypto";

/** Store a fingerprint in the encrypted JWT, never the password hash itself. */
export function credentialVersion(hashedPassword: string): string {
  return createHash("sha256").update(hashedPassword).digest("hex");
}
