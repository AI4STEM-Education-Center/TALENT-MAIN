// Client-safe pieces of the class access pause (no server imports), shared by
// the guard, the student UI and the fetch helpers.
export const DEFAULT_PAUSE_MESSAGE =
  "Access to the platform is paused for platform development. Please check back soon.";
export const PLATFORM_PAUSED_CODE = "PLATFORM_PAUSED";
export const PAUSED_PAGE_PATH = "/student/paused";

/** True when a parsed API error body is the paused-platform response. */
export function isPlatformPausedBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === PLATFORM_PAUSED_CODE
  );
}

/**
 * Send the browser to the paused page when a response is the paused-platform
 * 403. Returns true when it navigated, so callers can stop handling the error.
 * A hard navigation is deliberate: it drops all in-flight student UI state.
 */
export async function redirectIfPlatformPaused(
  res: Response,
): Promise<boolean> {
  if (res.status !== 403 || typeof window === "undefined") return false;
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  if (!isPlatformPausedBody(body)) return false;
  if (window.location.pathname !== PAUSED_PAGE_PATH)
    window.location.assign(PAUSED_PAGE_PATH);
  return true;
}
