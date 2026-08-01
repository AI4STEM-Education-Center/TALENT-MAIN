/**
 * Catalog of the transactional emails the app sends, and the pure helpers that
 * turn an admin's overrides into a concrete sender address and message body.
 *
 * Every purpose has a default local part (the bit before the "@"), so a fresh
 * install already sends password resets from `password-reset@<domain>` and
 * announcements from `notification@<domain>` without any configuration. Admins
 * override the local part, display name, reply-to — and, for the purposes whose
 * copy the app writes rather than a user, the subject and body — from
 * /admin/email. The domain is shared across every purpose (SmtpConfig.senderDomain).
 *
 * Deliberately free of Prisma/nodemailer imports so it stays unit-testable;
 * src/lib/email.ts is the side-effecting layer on top.
 */

export const EMAIL_PURPOSES = [
  "PASSWORD_RESET",
  "PASSWORD_CHANGED",
  "NOTIFICATION",
  "CONTACT_TEACHER",
  "SYSTEM_TEST",
] as const;

export type EmailPurpose = (typeof EMAIL_PURPOSES)[number];

export interface EmailPurposeDefinition {
  key: EmailPurpose;
  label: string;
  /** Shown in the admin UI so it's clear which flow the row governs. */
  description: string;
  defaultLocalPart: string;
  /**
   * Built-in copy for app-generated emails. Null when the body comes from a
   * user (class announcements, student→teacher messages) — those purposes only
   * expose the sender identity.
   */
  template: { subject: string; body: string } | null;
  /** Placeholder names available to the template, for the admin UI's hint line. */
  variables: string[];
}

const PASSWORD_RESET_TEMPLATE = {
  subject: "Reset your {{appName}} password",
  body: `Hi {{firstName}},

We received a request to reset the password for your {{appName}} account ({{username}}).

Use this link to choose a new password:
{{resetUrl}}

The link expires in {{expiresInMinutes}} minutes and can only be used once.

If you didn't ask for a password reset, you can ignore this email — your password stays unchanged.`,
};

const PASSWORD_CHANGED_TEMPLATE = {
  subject: "Your {{appName}} password was changed",
  body: `Hi {{firstName}},

The password for your {{appName}} account ({{username}}) was just changed on {{changedAt}}.

If this was you, nothing further is needed.

If it wasn't, reset your password immediately at {{resetRequestUrl}} and contact your administrator.`,
};

export const EMAIL_PURPOSE_DEFINITIONS: Record<EmailPurpose, EmailPurposeDefinition> = {
  PASSWORD_RESET: {
    key: "PASSWORD_RESET",
    label: "Password reset",
    description: "The reset link sent when someone uses “Forgot password?” on the sign-in page.",
    defaultLocalPart: "password-reset",
    template: PASSWORD_RESET_TEMPLATE,
    variables: ["appName", "firstName", "lastName", "username", "resetUrl", "expiresInMinutes"],
  },
  PASSWORD_CHANGED: {
    key: "PASSWORD_CHANGED",
    label: "Password changed notice",
    description: "The security confirmation sent after a password is changed or reset.",
    defaultLocalPart: "no-reply",
    template: PASSWORD_CHANGED_TEMPLATE,
    variables: ["appName", "firstName", "lastName", "username", "changedAt", "resetRequestUrl"],
  },
  NOTIFICATION: {
    key: "NOTIFICATION",
    label: "Class notifications",
    description: "Announcements a teacher emails to their class. The teacher writes the body.",
    defaultLocalPart: "notification",
    template: null,
    variables: [],
  },
  CONTACT_TEACHER: {
    key: "CONTACT_TEACHER",
    label: "Student → teacher messages",
    description: "Messages a student sends to their teacher. Replies go to the student.",
    defaultLocalPart: "no-contact",
    template: null,
    variables: [],
  },
  SYSTEM_TEST: {
    key: "SYSTEM_TEST",
    label: "SMTP test",
    description: "The test message sent from the “Test connection” box above.",
    defaultLocalPart: "no-reply",
    template: null,
    variables: [],
  },
};

export const APP_NAME = "AI4Talent";

/** Narrow an arbitrary string to a known purpose key. */
export function isEmailPurpose(value: unknown): value is EmailPurpose {
  return typeof value === "string" && (EMAIL_PURPOSES as readonly string[]).includes(value);
}

/**
 * Local parts must be safe to place before the "@" and readable in a From
 * header: lowercase letters, digits, dot/dash/underscore, no leading or
 * trailing separator. Returns the normalized value, or null when unusable.
 */
export function normalizeLocalPart(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 64) return null;
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Domains are stored bare. A pasted "@example.com" or "https://example.com/"
 * is forgiving-parsed down to "example.com"; anything that still doesn't look
 * like a hostname returns null.
 */
export function normalizeSenderDomain(value: string): string | null {
  let trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  trimmed = trimmed.replace(/^.*@/, "");
  if (trimmed.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) return null;
  return trimmed;
}

/** Minimal address check for reply-to inputs — nodemailer does the real parsing. */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export interface SenderOverride {
  localPart?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  subject?: string | null;
  body?: string | null;
}

export interface SenderIdentity {
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
}

/**
 * Resolve the address a purpose sends from.
 *
 * With a shared domain configured, the purpose's local part wins:
 * `password-reset@edwarcheng.net`. Without one there is nothing to build an
 * address from, so the SMTP config's single fromEmail is used unchanged — that
 * keeps existing installs working before an admin fills the domain in.
 */
export function resolveSenderIdentity(
  purpose: EmailPurpose,
  smtp: { fromEmail: string; fromName: string | null; senderDomain: string | null },
  override?: SenderOverride | null
): SenderIdentity {
  const definition = EMAIL_PURPOSE_DEFINITIONS[purpose];
  const domain = smtp.senderDomain ? normalizeSenderDomain(smtp.senderDomain) : null;
  const localPart =
    (override?.localPart ? normalizeLocalPart(override.localPart) : null) ??
    definition.defaultLocalPart;

  const replyTo = override?.replyTo?.trim();

  return {
    fromEmail: domain ? `${localPart}@${domain}` : smtp.fromEmail,
    fromName: override?.fromName?.trim() || smtp.fromName || null,
    replyTo: replyTo && isEmailAddress(replyTo) ? replyTo : null,
  };
}

/** Format a sender identity as an RFC 5322 From header value. */
export function formatFromHeader(identity: SenderIdentity): string {
  if (!identity.fromName) return identity.fromEmail;
  // Escape quotes/backslashes so a display name can't break out of the quoted
  // string and inject extra header content.
  const safeName = identity.fromName.replace(/[\\"]/g, "\\$&");
  return `"${safeName}" <${identity.fromEmail}>`;
}

/**
 * Substitute `{{placeholder}}` tokens. Unknown placeholders are left as-is so a
 * typo in an admin-edited template is visible rather than silently blanking
 * part of the message.
 */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

/**
 * Render a purpose's message, preferring the admin's override over the built-in
 * copy. Throws for purposes with no template (their body is user-authored).
 */
export function renderPurposeMessage(
  purpose: EmailPurpose,
  vars: Record<string, string | number>,
  override?: SenderOverride | null
): { subject: string; text: string } {
  const definition = EMAIL_PURPOSE_DEFINITIONS[purpose];
  if (!definition.template) {
    throw new Error(`Email purpose ${purpose} has no template — its body is supplied by the caller.`);
  }
  const subject = override?.subject?.trim() || definition.template.subject;
  const body = override?.body?.trim() || definition.template.body;
  return {
    subject: renderTemplate(subject, vars),
    text: renderTemplate(body, vars),
  };
}
