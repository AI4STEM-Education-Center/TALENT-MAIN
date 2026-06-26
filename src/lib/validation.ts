import { z } from "zod";
import { NextResponse } from "next/server";

/**
 * Centralized request-body validation built on zod. Routes parse untrusted
 * JSON through a schema here instead of hand-rolled `if (!x?.trim())` checks,
 * so every payload is type-checked (rejecting non-strings / oversized input)
 * and rejected uniformly with a 400. Add new route schemas to this file.
 */

/** A required string that is trimmed and must be non-empty after trimming. */
export const trimmedNonEmpty = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(200));

/** Shared shape for the teacher/admin self-registration endpoints. */
export const registerSchema = z.object({
  firstName: trimmedNonEmpty,
  lastName: trimmedNonEmpty,
  username: trimmedNonEmpty,
  email: trimmedNonEmpty,
  // Strength is enforced separately by validatePassword so its detailed,
  // user-facing message is preserved; here we only require a non-empty string.
  password: z.string().min(1),
});

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

/**
 * Validate `data` against `schema`. On success returns the parsed (and
 * transformed) value; on failure returns a ready-to-return 400 response.
 */
export function parseBody<T>(schema: z.ZodType<T>, data: unknown): ParseResult<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json({ error: "All fields are required." }, { status: 400 }),
    };
  }
  return { ok: true, data: result.data };
}
