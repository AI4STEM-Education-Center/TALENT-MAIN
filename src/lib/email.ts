import nodemailer, { type Transporter } from "nodemailer";
import { prisma } from "@/lib/prisma";
import { decryptApiKey } from "@/lib/crypto";
import {
  APP_NAME,
  EMAIL_PURPOSE_DEFINITIONS,
  formatFromHeader,
  renderPurposeMessage,
  resolveSenderIdentity,
  type EmailPurpose,
  type SenderIdentity,
  type SenderOverride,
} from "@/lib/email-purposes";

export interface ResolvedSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  fromEmail: string;
  fromName: string | null;
  /** Shared domain for per-purpose sender addresses; null = use fromEmail. */
  senderDomain: string | null;
  isActive: boolean;
}

/**
 * Load the singleton SMTP config from the database and decrypt the password.
 * Returns null when no config row exists.
 */
export async function getSmtpConfig(): Promise<ResolvedSmtpConfig | null> {
  const cfg = await prisma.smtpConfig.findFirst();
  if (!cfg) return null;

  let password: string | null = null;
  if (cfg.passwordEnc && cfg.passwordIv && cfg.passwordTag) {
    try {
      password = decryptApiKey(cfg.passwordEnc, cfg.passwordIv, cfg.passwordTag);
    } catch {
      password = null;
    }
  }

  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    username: cfg.username,
    password,
    fromEmail: cfg.fromEmail,
    fromName: cfg.fromName,
    senderDomain: cfg.senderDomain,
    isActive: cfg.isActive,
  };
}

/**
 * Build a nodemailer transport from a resolved SMTP config.
 */
export function createTransport(cfg: ResolvedSmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth:
      cfg.username && cfg.password
        ? { user: cfg.username, pass: cfg.password }
        : undefined,
  });
}

/** Load an admin's overrides for one purpose (null when never customized). */
export async function getSenderOverride(purpose: EmailPurpose): Promise<SenderOverride | null> {
  const row = await prisma.emailSender.findUnique({ where: { purpose } });
  if (!row) return null;
  return {
    localPart: row.localPart,
    fromName: row.fromName,
    replyTo: row.replyTo,
    subject: row.subject,
    body: row.body,
  };
}

/**
 * The address a given purpose sends from, after applying the admin's overrides
 * on top of the catalog defaults.
 */
export async function getSenderIdentity(
  purpose: EmailPurpose,
  cfg: ResolvedSmtpConfig
): Promise<SenderIdentity> {
  return resolveSenderIdentity(purpose, cfg, await getSenderOverride(purpose));
}

export interface SendResult {
  sent: number;
  failed: number;
  errors: string[];
}

export class SmtpNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpNotConfiguredError";
  }
}

interface SendOptions {
  to: string[];
  subject: string;
  text: string;
  /**
   * Which configured sender identity to send as. Defaults to NOTIFICATION —
   * the purpose behind the pre-existing teacher→class email path.
   */
  purpose?: EmailPurpose;
  /**
   * Reply-to for this specific message (e.g. the human sender's real address).
   * Overrides the purpose's configured reply-to.
   */
  replyTo?: string;
}

/**
 * Load and validate the SMTP config for sending, throwing the same
 * SmtpNotConfiguredError callers already handle.
 */
async function requireSendableConfig(): Promise<ResolvedSmtpConfig> {
  const cfg = await getSmtpConfig();
  if (!cfg) {
    throw new SmtpNotConfiguredError(
      "No SMTP server is configured. An administrator must set one up first."
    );
  }
  if (!cfg.isActive) {
    throw new SmtpNotConfiguredError(
      "Email sending is currently disabled. An administrator must enable the SMTP server."
    );
  }
  return cfg;
}

/**
 * Send one email and let the transport's own error escape untouched.
 *
 * sendEmail() flattens per-recipient failures into strings, which is fine for
 * a fire-and-forget broadcast but throws away the SMTP response code. The queue
 * worker needs that code to tell "this mailbox does not exist" (never retry)
 * from "the server is busy" (retry), so single-recipient delivery goes through
 * here instead. See src/lib/message-email.ts.
 */
export async function sendEmailToRecipient(opts: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}): Promise<void> {
  const cfg = await requireSendableConfig();
  const identity = await getSenderIdentity("NOTIFICATION", cfg);
  await createTransport(cfg).sendMail({
    from: formatFromHeader(identity),
    to: opts.to,
    replyTo: opts.replyTo ?? identity.replyTo ?? undefined,
    subject: opts.subject,
    text: opts.text,
  });
}

/**
 * Send an email to one or more recipients using the configured SMTP server.
 * Each recipient is sent an individual message (BCC-style privacy) so students
 * don't see each other's addresses. Throws SmtpNotConfiguredError when SMTP is
 * missing or inactive.
 */
export async function sendEmail(opts: SendOptions): Promise<SendResult> {
  const cfg = await requireSendableConfig();

  const recipients = opts.to.map((e) => e.trim()).filter(Boolean);
  if (recipients.length === 0) {
    return { sent: 0, failed: 0, errors: [] };
  }

  const identity = await getSenderIdentity(opts.purpose ?? "NOTIFICATION", cfg);
  const transport = createTransport(cfg);
  const from = formatFromHeader(identity);
  const replyTo = opts.replyTo ?? identity.replyTo ?? undefined;

  const results = await Promise.allSettled(
    recipients.map((to) =>
      transport.sendMail({
        from,
        to,
        replyTo,
        subject: opts.subject,
        text: opts.text,
      })
    )
  );

  const errors: string[] = [];
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      sent++;
    } else {
      failed++;
      errors.push(`${recipients[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  }

  return { sent, failed, errors };
}

/**
 * Send one of the app-authored emails (password reset, password-changed
 * notice): renders the purpose's template — the admin's override if there is
 * one — and sends it from that purpose's address.
 *
 * `appName` is always available to templates, so callers only pass the
 * flow-specific variables.
 */
export async function sendPurposeEmail(
  purpose: EmailPurpose,
  to: string,
  vars: Record<string, string | number>
): Promise<SendResult> {
  const cfg = await requireSendableConfig();
  const override = await getSenderOverride(purpose);
  const { subject, text } = renderPurposeMessage(purpose, { appName: APP_NAME, ...vars }, override);
  const identity = resolveSenderIdentity(purpose, cfg, override);

  const transport = createTransport(cfg);
  try {
    await transport.sendMail({
      from: formatFromHeader(identity),
      to,
      replyTo: identity.replyTo ?? undefined,
      subject,
      text,
    });
    return { sent: 1, failed: 0, errors: [] };
  } catch (error) {
    return {
      sent: 0,
      failed: 1,
      errors: [`${to}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * Verify SMTP connectivity for a given config (used by the admin "Send test"
 * action). Optionally sends a test email to `testRecipient`.
 */
export async function verifyAndTest(
  cfg: ResolvedSmtpConfig,
  testRecipient?: string
): Promise<void> {
  const transport = createTransport(cfg);
  await transport.verify();

  if (testRecipient) {
    const identity = await getSenderIdentity("SYSTEM_TEST", cfg);
    await transport.sendMail({
      from: formatFromHeader(identity),
      to: testRecipient,
      subject: `${APP_NAME} SMTP test email`,
      text:
        `This is a test email confirming your ${APP_NAME} SMTP configuration works correctly.\n\n` +
        `It was sent from ${identity.fromEmail} — the address configured for ` +
        `"${EMAIL_PURPOSE_DEFINITIONS.SYSTEM_TEST.label}".`,
    });
  }
}
