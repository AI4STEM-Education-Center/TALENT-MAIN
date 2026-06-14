import { prisma } from "@/lib/prisma";

/**
 * Default per-teacher email sending caps, counted in recipient-emails (a
 * broadcast to 30 students = 30 emails). Admins can override either cap per
 * teacher via Teacher.emailDailyLimit / Teacher.emailMonthlyLimit (null = use
 * the default here). In-app notifications are unlimited and never counted.
 */
export const DEFAULT_EMAIL_DAILY_LIMIT = 100;
export const DEFAULT_EMAIL_MONTHLY_LIMIT = 3000;

export interface Channels {
  inApp: boolean;
  email: boolean;
}

/**
 * Parse a channel selection from request input (a Message.channels string like
 * "IN_APP,EMAIL", or a { inApp, email } object) into a normalized Channels.
 */
export function parseChannels(input: unknown): Channels {
  if (typeof input === "string") {
    const parts = input.split(",").map((p) => p.trim().toUpperCase());
    return { inApp: parts.includes("IN_APP"), email: parts.includes("EMAIL") };
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    return { inApp: obj.inApp === true, email: obj.email === true };
  }
  return { inApp: false, email: false };
}

/** Serialize channels to the comma-joined form stored in Message.channels. */
export function serializeChannels(channels: Channels): string {
  const parts: string[] = [];
  if (channels.inApp) parts.push("IN_APP");
  if (channels.email) parts.push("EMAIL");
  return parts.join(",");
}

export interface QuotaInput {
  dailyLimit: number;
  dailyUsed: number;
  monthlyLimit: number;
  monthlyUsed: number;
  /** Number of email recipients the teacher wants to send right now. */
  requested?: number;
}

export interface QuotaResult {
  dailyLimit: number;
  dailyUsed: number;
  dailyRemaining: number;
  monthlyLimit: number;
  monthlyUsed: number;
  monthlyRemaining: number;
  /** Smaller of the two remaining budgets — the effective ceiling. */
  remaining: number;
  /** True when `requested` (0 if omitted) fits within `remaining`. */
  allowed: boolean;
}

/**
 * Compute remaining email budget and whether a requested send is allowed.
 * Pure (no I/O) so it is unit-tested directly.
 */
export function evaluateQuota(input: QuotaInput): QuotaResult {
  const dailyRemaining = Math.max(0, input.dailyLimit - input.dailyUsed);
  const monthlyRemaining = Math.max(0, input.monthlyLimit - input.monthlyUsed);
  const remaining = Math.min(dailyRemaining, monthlyRemaining);
  const requested = input.requested ?? 0;
  return {
    dailyLimit: input.dailyLimit,
    dailyUsed: input.dailyUsed,
    dailyRemaining,
    monthlyLimit: input.monthlyLimit,
    monthlyUsed: input.monthlyUsed,
    monthlyRemaining,
    remaining,
    allowed: requested <= remaining,
  };
}

/** Start of the current day in server local time. */
export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Start of the current calendar month in server local time. */
export function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export interface TeacherLimitOverrides {
  emailDailyLimit: number | null;
  emailMonthlyLimit: number | null;
}

/**
 * Resolve a teacher's effective email quota: their per-teacher overrides (or
 * the global defaults) minus the recipient-emails they've already sent in the
 * current day / month. Counts ATTEMPTED recipients (Message.recipientCount on
 * email-channel messages) so retrying failed sends can't bypass the cap.
 */
export async function getTeacherEmailQuota(
  teacherUserId: string,
  overrides: TeacherLimitOverrides,
  now: Date = new Date()
): Promise<QuotaResult> {
  const dailyLimit = overrides.emailDailyLimit ?? DEFAULT_EMAIL_DAILY_LIMIT;
  const monthlyLimit = overrides.emailMonthlyLimit ?? DEFAULT_EMAIL_MONTHLY_LIMIT;

  const emailFilter = {
    senderUserId: teacherUserId,
    channels: { contains: "EMAIL" },
  } as const;

  const [day, month] = await Promise.all([
    prisma.message.aggregate({
      _sum: { recipientCount: true },
      where: { ...emailFilter, createdAt: { gte: startOfDay(now) } },
    }),
    prisma.message.aggregate({
      _sum: { recipientCount: true },
      where: { ...emailFilter, createdAt: { gte: startOfMonth(now) } },
    }),
  ]);

  return evaluateQuota({
    dailyLimit,
    dailyUsed: day._sum.recipientCount ?? 0,
    monthlyLimit,
    monthlyUsed: month._sum.recipientCount ?? 0,
  });
}
