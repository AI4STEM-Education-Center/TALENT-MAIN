/**
 * Catalog of the transactional emails the app sends, and the pure helpers that
 * turn an admin's overrides into a concrete sender address and message body.
 *
 * Every purpose has a default local part (the bit before the "@"), so a fresh
 * install already sends password resets from `password-reset@<domain>` and
 * announcements from `notification@<domain>` without any configuration. Admins
 * override the local part, display name, reply-to, subject and body from
 * /admin/email — every purpose ships an editable template whose placeholders
 * are listed in the UI with a live receiver preview. User-authored content
 * (the teacher's announcement subject, the student's message body) arrives as
 * template variables such as {{subject}} / {{body}}, so the wrapper stays
 * customizable without losing the human-written part. The domain is shared
 * across every purpose (SmtpConfig.senderDomain).
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
  "CONSENT_CONFIRMATION",
  "CONSENT_EXPORT_REQUEST",
  "CONSENT_EXPORT_READY",
  "SECURITY_ALERT",
] as const;

export type EmailPurpose = (typeof EMAIL_PURPOSES)[number];

export interface EmailPurposeDefinition {
  key: EmailPurpose;
  label: string;
  /** Shown in the admin UI so it's clear which flow the row governs. */
  description: string;
  defaultLocalPart: string;
  /**
   * Built-in copy every purpose renders through. User-authored content arrives
   * as variables ({{subject}} / {{body}}), so the admin-editable wrapper never
   * swallows the human-written part. Kept nullable for backward compatibility
   * with stored rows — the catalog itself defines a template for all purposes.
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

const CONSENT_CONFIRMATION_TEMPLATE = {
  subject: "Your {{appName}} research consent record",
  body: `Hi {{firstName}},

This confirms your response to the "{{formTitle}}" ({{formVersion}}): {{decisionText}}.

A copy of your completed, signed form is attached as a PDF for your records.

If you have questions about this research study, contact the study's Principal Investigator or your institution's IRB using the contact information in the attached form.`,
};

const NOTIFICATION_TEMPLATE = {
  subject: "{{subjectLine}}",
  body: `{{greetingLine}}

Subject: {{subject}}

{{messageLinkLine}}

This is an automated notification — the message itself is waiting for you in the app.`,
};

const CONTACT_TEACHER_TEMPLATE = {
  subject: "{{subjectLine}}",
  body: `{{body}}

— {{studentName}}
Student email: {{studentEmail}}
Class: {{className}}`,
};

const SYSTEM_TEST_TEMPLATE = {
  subject: "{{appName}} SMTP test email",
  body: `This is a test email confirming your {{appName}} SMTP configuration works correctly.

It was sent from {{fromEmail}} — the address configured for "{{purposeLabel}}".`,
};

const CONSENT_EXPORT_REQUEST_TEMPLATE = {
  subject: "Consent export requested: {{className}}",
  body: `{{teacherName}} has requested a signed-students export for "{{className}}".

Grade column: {{gradeColumnName}} ({{pointsAwarded}} points)

Review and approve or reject the request: {{reviewUrl}}`,
};

const CONSENT_EXPORT_READY_TEMPLATE = {
  subject: "Your consent export for {{className}} is ready",
  body: `Your requested consent-credit export for "{{className}}" was approved.

Grade column: {{gradeColumnName}} ({{pointsAwarded}} points)

The attached CSV is formatted for direct import into eLC's Grades tool.`,
};

const SECURITY_ALERT_TEMPLATE = {
  subject: "[{{appName}}] Revoked ingestion token used — possible leak",
  body: `Hi,

A revoked result-ingestion token was just used to call POST /api/pressure-results on {{appName}}.

Token: {{tokenName}} ({{tokenPrefix}}…)
When: {{usedAt}}
Source IP: {{ip}}
Times used since revocation: {{useCount}}

This may point to a token leak — the old token may still live in a GitHub Actions secret, a local pressure/.env file, or a log. Remove the leaked value wherever it is stored and confirm no unexpected results were ingested.

Review tokens in Admin → Pressure Tests.`,
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
    description: "Announcements a teacher emails to their class. The teacher writes the subject and the message lives in the app — this template is the email nudge pointing at it.",
    defaultLocalPart: "notification",
    template: NOTIFICATION_TEMPLATE,
    variables: ["appName", "senderName", "className", "subject", "subjectLine", "greetingLine", "messageUrl", "messageLinkLine"],
  },
  CONTACT_TEACHER: {
    key: "CONTACT_TEACHER",
    label: "Student → teacher messages",
    description: "Messages a student sends to their teacher. Replies go to the student.",
    defaultLocalPart: "no-contact",
    template: CONTACT_TEACHER_TEMPLATE,
    variables: ["appName", "studentName", "studentEmail", "className", "subject", "subjectLine", "body"],
  },
  SYSTEM_TEST: {
    key: "SYSTEM_TEST",
    label: "SMTP test",
    description: "The test message sent from the “Test connection” box above.",
    defaultLocalPart: "no-reply",
    template: SYSTEM_TEST_TEMPLATE,
    variables: ["appName", "fromEmail", "purposeLabel"],
  },
  CONSENT_CONFIRMATION: {
    key: "CONSENT_CONFIRMATION",
    label: "Consent record confirmation",
    description: "Sent to a student or teacher after they respond to a research consent form, with a signed PDF copy attached.",
    defaultLocalPart: "consent",
    template: CONSENT_CONFIRMATION_TEMPLATE,
    variables: ["appName", "firstName", "lastName", "formTitle", "formVersion", "decisionText"],
  },
  CONSENT_EXPORT_REQUEST: {
    key: "CONSENT_EXPORT_REQUEST",
    label: "Consent export request (to admin)",
    description: "Sent to the administrator a teacher selects when requesting a signed-students export.",
    defaultLocalPart: "consent",
    template: CONSENT_EXPORT_REQUEST_TEMPLATE,
    variables: ["appName", "teacherName", "className", "gradeColumnName", "pointsAwarded", "reviewUrl"],
  },
  CONSENT_EXPORT_READY: {
    key: "CONSENT_EXPORT_READY",
    label: "Consent export ready (to teacher)",
    description: "Sent to a teacher once an admin approves their signed-students export request, with the CSV attached.",
    defaultLocalPart: "consent",
    template: CONSENT_EXPORT_READY_TEMPLATE,
    variables: ["appName", "className", "gradeColumnName", "pointsAwarded"],
  },
  SECURITY_ALERT: {
    key: "SECURITY_ALERT",
    label: "Security alerts (to admin)",
    description: "Sent to every administrator when a revoked ingestion token is used — a possible token leak.",
    defaultLocalPart: "no-reply",
    template: SECURITY_ALERT_TEMPLATE,
    variables: ["appName", "tokenName", "tokenPrefix", "usedAt", "ip", "useCount"],
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
 * copy. Every catalog purpose ships a default template; the throw only guards
 * against a hypothetical purpose without one.
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
