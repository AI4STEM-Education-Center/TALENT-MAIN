export const ONE_DAY_SECONDS = 24 * 60 * 60;
export const THIRTY_DAYS_SECONDS = 30 * ONE_DAY_SECONDS;

/**
 * Auth.js serializes credential fields as strings. Only the literal value
 * emitted by the checked login control opts a device into the longer session.
 */
export function shouldRememberComputer(value: unknown): boolean {
  return value === "true";
}

/** Absolute Unix timestamp used to prevent Auth.js session refreshes from extending access. */
export function sessionExpiresAt(
  rememberComputer: boolean,
  nowMs = Date.now(),
): number {
  const lifetime = rememberComputer ? THIRTY_DAYS_SECONDS : ONE_DAY_SECONDS;
  return Math.floor(nowMs / 1000) + lifetime;
}

export function isSessionExpired(
  expiresAt: unknown,
  nowMs = Date.now(),
): boolean {
  return typeof expiresAt !== "number" || expiresAt <= Math.floor(nowMs / 1000);
}

/**
 * Keep the encrypted JWT's own expiry aligned with the absolute session
 * deadline when Auth.js refreshes the cookie during a session read.
 */
export function remainingSessionSeconds(
  expiresAt: unknown,
  nowMs = Date.now(),
): number {
  if (typeof expiresAt !== "number") return 0;
  return Math.max(0, expiresAt - Math.floor(nowMs / 1000));
}
