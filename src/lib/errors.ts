/**
 * Shared helpers for working with caught errors.
 *
 * `catch` bindings are `unknown` by default under `strict` (and this repo
 * types them explicitly as `unknown`). Use {@link errorMessage} instead of
 * reaching for `any` or repeating `err instanceof Error ? ... : ...` inline.
 */

/** Extract a human-readable message from an unknown caught value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
