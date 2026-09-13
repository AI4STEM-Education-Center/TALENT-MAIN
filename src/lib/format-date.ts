/**
 * Deterministic date formatting for values that render on both the server and
 * the client.
 *
 * `toLocaleDateString()` / `toLocaleString()` with no arguments format using the
 * *runtime's* locale and timezone. During SSR that is the Node server's; after
 * hydration it is the visitor's browser. When the value comes from a server
 * component prop, the two passes disagree and React reports a hydration
 * mismatch — pinning both settings makes them agree.
 *
 * Eastern matches the institution this app is deployed for, and is the same
 * default the backup scheduler falls back to (see `src/lib/backup.ts`).
 *
 * Values loaded *after* mount (client fetches, polling) never render during SSR
 * and can keep using the visitor's own locale.
 */
export const DISPLAY_LOCALE = "en-US";
export const DISPLAY_TIME_ZONE = "America/New_York";

/** e.g. "3/14/2026" — stable across server and browser. */
export function formatDate(value: string | number | Date): string {
  return new Date(value).toLocaleDateString(DISPLAY_LOCALE, {
    timeZone: DISPLAY_TIME_ZONE,
  });
}

/** e.g. "3/14/2026, 9:05 AM" — stable across server and browser. */
export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(DISPLAY_LOCALE, {
    timeZone: DISPLAY_TIME_ZONE,
  });
}
