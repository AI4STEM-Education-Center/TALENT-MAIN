import nodemailer, { type Transporter } from "nodemailer";
import { prisma } from "@/lib/prisma";
import { decryptApiKey } from "@/lib/crypto";

export interface ResolvedSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  fromEmail: string;
  fromName: string | null;
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

function formatFrom(cfg: ResolvedSmtpConfig): string {
  return cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;
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
  /** Optional reply-to address (e.g. the sender's real email). */
  replyTo?: string;
}

/**
 * Load the SMTP config and refuse unless it exists and is enabled. Shared by
 * every send path so "not configured" always surfaces the same way.
 */
async function requireActiveSmtpConfig(): Promise<ResolvedSmtpConfig> {
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
  const cfg = await requireActiveSmtpConfig();
  await createTransport(cfg).sendMail({
    from: formatFrom(cfg),
    to: opts.to,
    replyTo: opts.replyTo,
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
  const cfg = await requireActiveSmtpConfig();

  const recipients = opts.to.map((e) => e.trim()).filter(Boolean);
  if (recipients.length === 0) {
    return { sent: 0, failed: 0, errors: [] };
  }

  const transport = createTransport(cfg);
  const from = formatFrom(cfg);

  const results = await Promise.allSettled(
    recipients.map((to) =>
      transport.sendMail({
        from,
        to,
        replyTo: opts.replyTo,
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
    await transport.sendMail({
      from: formatFrom(cfg),
      to: testRecipient,
      subject: "AI4Talent SMTP test email",
      text: "This is a test email confirming your AI4Talent SMTP configuration works correctly.",
    });
  }
}
