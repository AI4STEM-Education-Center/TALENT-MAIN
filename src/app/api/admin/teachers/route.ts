import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";
import {
  getTeacherEmailQuota,
  DEFAULT_EMAIL_DAILY_LIMIT,
  DEFAULT_EMAIL_MONTHLY_LIMIT,
} from "@/lib/email-limits";

// GET /api/admin/teachers
// All teachers with their email-limit overrides and current day/month usage,
// for the admin "Email Limits" page. Includes the global defaults so the UI can
// show them as placeholders when an override is unset.
export async function GET() {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  const teachers = await prisma.teacher.findMany({
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
    orderBy: { user: { lastName: "asc" } },
  });

  const rows = await Promise.all(
    teachers.map(async (t) => {
      const quota = await getTeacherEmailQuota(t.userId, {
        emailDailyLimit: t.emailDailyLimit,
        emailMonthlyLimit: t.emailMonthlyLimit,
      });
      return {
        id: t.id,
        userId: t.userId,
        firstName: t.user.firstName,
        lastName: t.user.lastName,
        email: t.user.email,
        emailDailyLimit: t.emailDailyLimit,
        emailMonthlyLimit: t.emailMonthlyLimit,
        quota,
      };
    }),
  );

  return NextResponse.json({
    teachers: rows,
    defaults: {
      emailDailyLimit: DEFAULT_EMAIL_DAILY_LIMIT,
      emailMonthlyLimit: DEFAULT_EMAIL_MONTHLY_LIMIT,
    },
  });
}
