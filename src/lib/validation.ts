import { z } from "zod";
import { NextResponse } from "next/server";
import {
  MAX_TELEMETRY_MS,
  MAX_TELEMETRY_COUNT,
  sanitizeControlCounts,
} from "./simulation-telemetry";

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

/**
 * Password inputs. Strength is enforced separately by validatePassword so its
 * detailed, user-facing message is preserved; the cap only stops an absurdly
 * long string from reaching bcrypt.
 */
const passwordField = z.string().min(1).max(200);

/** Self-service profile edit (name + email). Username is not editable. */
export const profileUpdateSchema = z.object({
  firstName: trimmedNonEmpty,
  lastName: trimmedNonEmpty,
  email: trimmedNonEmpty,
});

/** Signed-in password change — the current password re-authenticates the user. */
export const changePasswordSchema = z.object({
  currentPassword: passwordField,
  newPassword: passwordField,
});

/** "Forgot password?" — an email address or a username. */
export const forgotPasswordSchema = z.object({
  identifier: trimmedNonEmpty,
});

/** Redeeming an emailed reset link. */
export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(200),
  password: passwordField,
});

// ─── Per-purpose email senders ──────────────────────────────────────────────
// Shapes for the admin's /admin/email sender overrides. Values are only
// shape-checked here; address/domain syntax is normalized by
// src/lib/email-purposes.ts so the UI and the sender share one definition.

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .nullish()
    .transform((s) => (s ? s : null));

export const emailSenderRowSchema = z.object({
  purpose: z.string().min(1).max(64),
  localPart: z.string().max(64).transform((s) => s.trim()),
  fromName: optionalText(200),
  replyTo: optionalText(320),
  subject: optionalText(300),
  body: optionalText(10_000),
});

export const emailSendersUpdateSchema = z.object({
  // Empty string clears the shared domain (every purpose falls back to the
  // SMTP config's single From address).
  senderDomain: z.string().max(253).transform((s) => s.trim()).nullish(),
  senders: z.array(emailSenderRowSchema).max(50),
});

// ─── Concept / Misconception catalog import ────────────────────────────────
// Bodies are the already-parsed rows produced client-side by
// src/lib/concept-csv.ts (the browser parses the CSV; routes only validate the
// resulting JSON shape). Row counts are capped so a malformed/huge upload
// can't wedge the import transaction.
const MAX_IMPORT_ROWS = 5000;

const optionalTrimmed = z
  .string()
  .transform((s) => s.trim())
  .nullable()
  .optional()
  .transform((s) => (s ? s : null));

export const conceptImportRowSchema = z.object({
  conceptId: trimmedNonEmpty,
  kind: z.string().transform((s) => s.trim()),
  parentApLo: optionalTrimmed,
  unit: optionalTrimmed,
  topic: optionalTrimmed,
  displayName: trimmedNonEmpty,
  description: optionalTrimmed,
  sourceLoCode: optionalTrimmed,
  comments: optionalTrimmed,
  notes: optionalTrimmed,
  url: optionalTrimmed,
  deprecated: z.boolean().default(false),
  deprecationNote: optionalTrimmed,
});

export const conceptsImportSchema = z.object({
  concepts: z.array(conceptImportRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

export const misconceptionImportRowSchema = z.object({
  misconceptionId: trimmedNonEmpty,
  statement: z.string().transform((s) => s.trim()),
  sourceCitation: optionalTrimmed,
  link: optionalTrimmed,
  sourceType: optionalTrimmed,
  notes: optionalTrimmed,
  deprecated: z.boolean().default(false),
  deprecationNote: optionalTrimmed,
});

export const misconceptionsImportSchema = z.object({
  misconceptions: z.array(misconceptionImportRowSchema).min(1).max(MAX_IMPORT_ROWS),
});

export const mappingImportRowSchema = z.object({
  misconceptionId: trimmedNonEmpty,
  conceptId: trimmedNonEmpty,
  confidence: optionalTrimmed,
  notes: optionalTrimmed,
});

export const externalRefImportRowSchema = z.object({
  conceptId: trimmedNonEmpty,
  refCode: trimmedNonEmpty,
  refType: trimmedNonEmpty,
  sourceUrl: optionalTrimmed,
});

export const conceptMappingsImportSchema = z
  .object({
    mappings: z.array(mappingImportRowSchema).max(MAX_IMPORT_ROWS),
    externalRefs: z.array(externalRefImportRowSchema).max(MAX_IMPORT_ROWS),
  })
  .refine((value) => value.mappings.length + value.externalRefs.length > 0, {
    message: "At least one mapping or external reference is required.",
  });

// ─── Simulation telemetry ───────────────────────────────────────────────────
// Payloads for the student simulation-session endpoints. Durations/counters
// are clamped (not rejected) past their caps — see simulation-telemetry.ts —
// so an overflowing honest session still records.

const boundedMs = z
  .number()
  .int()
  .min(0)
  .transform((v) => Math.min(v, MAX_TELEMETRY_MS));
const boundedCount = z
  .number()
  .int()
  .min(0)
  .transform((v) => Math.min(v, MAX_TELEMETRY_COUNT));

export const simulationSessionCreateSchema = z.object({
  attemptId: z
    .string()
    .max(64)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  surface: z.enum(["rail", "mobile"]),
});

export const simulationSessionUpdateSchema = z.object({
  dwellMs: boundedMs,
  activeMs: boundedMs,
  interactionCount: boundedCount,
  paramChanges: boundedCount,
  controls: z
    .record(z.string().max(200), z.number().int().min(0))
    .optional()
    .transform((v) => sanitizeControlCounts(v ?? {})),
  ended: z.boolean().default(false),
});

// ─── IRB research consent ───────────────────────────────────────────────────
// Stroke data (drawn initials/signature) is only shape-checked as "present or
// not" here — src/lib/consent.ts's normalizeStrokeData does the real
// shape/size validation, since it needs to throw a specific oversized-payload
// error rather than a generic 400.

export const consentSubmitSchema = z.object({
  decision: z.enum(["AGREE", "DECLINE"]),
  interviewRecordingConsent: z.boolean().optional(),
  initialsStrokeData: z.unknown().optional(),
  signatureTypedName: z.string().trim().min(1).max(200),
  signatureStrokeData: z.unknown().optional(),
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
