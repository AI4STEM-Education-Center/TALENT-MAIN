/**
 * The research-scientist view of the system log (SystemLog), shared by
 * GET /api/admin/logs and the research export ZIP so the two can never
 * disagree. Administrators always see the raw log.
 *
 * Log rows are written all over the codebase, and some carry deployment
 * configuration (an AI-config import's report lists providers, models and
 * use-case assignments; a failed safety check names the model; provider and
 * SMTP errors can embed base URLs or hosts). Research scientists may not see
 * configuration anywhere else, so their projection is built to fail closed:
 *
 * 1. metadata is always dropped — new payloads are hidden by default.
 * 2. Rows whose type belongs to an admin-only config/operations area are
 *    dropped entirely (RESEARCHER_HIDDEN_LOG_TYPES / _PREFIXES). Derived from
 *    every logSystemEvent and logApiError call site: AI config/providers/
 *    models/assignments, assistant and guardrail settings, SMTP and e-mail
 *    senders, backups, pressure tests and ingestion tokens, invite-code
 *    management, resource monitoring.
 * 3. On the rows that remain, the message is kept only for types whose
 *    message is known to be built from non-config values
 *    (RESEARCHER_MESSAGE_SAFE_LOG_TYPES); every other message — raw error
 *    text from jobs, providers or e-mail, including types added later — is
 *    replaced with RESEARCHER_WITHHELD_MESSAGE. Type, category, severity,
 *    time, user and IP stay, so activity and error rates remain analysable.
 *
 * Pure (no Prisma client import) so it unit-tests without a database.
 */

/** Exact log types a research scientist never sees. */
export const RESEARCHER_HIDDEN_LOG_TYPES: readonly string[] = [
  // Guardrail settings could not be read (guardrail-settings.ts).
  "SETTINGS_READ_FAILED",
  // Names the configured model (assistant/agent.ts).
  "ASSISTANT_THINKING_LEVEL_DROPPED",
  // Names the configured model and carries the provider's raw error.
  "SAFETY_CHECK_UNAVAILABLE",
  "MODERATION_UNAVAILABLE",
  // Assistant settings route errors (logApiError tag).
  "ASSISTANT_CONFIG",
  "GUARDRAIL_MODERATION_TEST",
  "S3_GC_FAILED",
];

/**
 * Log type prefixes a research scientist never sees. Covers both
 * logSystemEvent types and the logApiError route tags of the config routes.
 */
export const RESEARCHER_HIDDEN_LOG_TYPE_PREFIXES: readonly string[] = [
  // AI_CONFIG_EXPORT / AI_CONFIG_IMPORT (full provider/model/assignment
  // report in metadata), AI_PROVIDER*, AI_MODELS_*, AI_ASSIGNMENT*.
  "AI_",
  // Invite-code management (labels) and its route tags.
  "TEACHER_CODE_",
  "ADMIN_TEACHER_CODES_",
  // PRESSURE_TOKEN_REVOKED_USE (token names), PRESSURE_RESULT_POST.
  "PRESSURE_",
  "ADMIN_PRESSURE_",
  // BACKUP_FAILED (bucket/paths in the error), BACKUP_* route tags.
  "BACKUP_",
  "SMTP_",
  "ADMIN_EMAIL_SENDERS_",
  "ADMIN_ASSISTANTS_",
  "ADMIN_GUARDRAIL",
  "ADMIN_RESOURCES",
];

/** Types whose message is built only from non-config values. */
export const RESEARCHER_MESSAGE_SAFE_LOG_TYPES: readonly string[] = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGIN_RATE_LIMITED",
  "ACCOUNT_REGISTERED",
  "REGISTRATION_CODE_REJECTED",
  "PASSWORD_CHANGED",
  "PASSWORD_CHANGE_FAILED",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET_THROTTLED",
  "PASSWORD_RESET_REJECTED",
  "PASSWORD_RESET_COMPLETED",
  "PROFILE_UPDATE_FAILED",
  "USAGE_SAMPLE",
  "MODERATION_FLAG",
  "SAFETY_BLOCK",
  "SAFETY_FLAG",
  "SAFETY_CHECK_PARTIAL",
  "FEEDBACK_SUBMITTED",
  "DATA_EXPORT",
];

export const RESEARCHER_WITHHELD_MESSAGE =
  "Detail withheld from the research scientist view.";

export function isResearcherHiddenLogType(type: string): boolean {
  return (
    RESEARCHER_HIDDEN_LOG_TYPES.includes(type) ||
    RESEARCHER_HIDDEN_LOG_TYPE_PREFIXES.some((prefix) =>
      type.startsWith(prefix),
    )
  );
}

/**
 * A log row as a research scientist may see it, or null when the whole row
 * is hidden. metadata is always null in the result.
 */
export function toResearcherSafeLog<
  T extends { type: string; message: string; metadata?: string | null },
>(row: T): (T & { metadata: null }) | null {
  if (isResearcherHiddenLogType(row.type)) return null;
  return {
    ...row,
    message: RESEARCHER_MESSAGE_SAFE_LOG_TYPES.includes(row.type)
      ? row.message
      : RESEARCHER_WITHHELD_MESSAGE,
    metadata: null,
  };
}

/**
 * Prisma `where` fragment selecting only rows toResearcherSafeLog keeps, so
 * pagination and totals in the logs API match what is shown.
 */
export function researcherVisibleLogWhere() {
  return {
    NOT: [
      { type: { in: [...RESEARCHER_HIDDEN_LOG_TYPES] } },
      ...RESEARCHER_HIDDEN_LOG_TYPE_PREFIXES.map((prefix) => ({
        type: { startsWith: prefix },
      })),
    ],
  };
}
