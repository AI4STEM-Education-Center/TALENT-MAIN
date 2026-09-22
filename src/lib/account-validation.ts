export const PASSWORD_REQUIREMENTS =
  "Password must be at least 8 characters and include uppercase, lowercase, number, and special character.";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

export function validatePassword(password: string) {
  // bcrypt only hashes the first 72 UTF-8 bytes. Reject longer new passwords
  // rather than silently accepting different passwords as the same credential.
  if (new TextEncoder().encode(password).length > 72) {
    return "Password must be no more than 72 UTF-8 bytes.";
  }
  if (password.length < 8) return PASSWORD_REQUIREMENTS;
  if (!/[A-Z]/.test(password)) return PASSWORD_REQUIREMENTS;
  if (!/[a-z]/.test(password)) return PASSWORD_REQUIREMENTS;
  if (!/[0-9]/.test(password)) return PASSWORD_REQUIREMENTS;
  if (!/[^A-Za-z0-9\s]/.test(password)) return PASSWORD_REQUIREMENTS;

  return null;
}
