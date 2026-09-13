import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTeacherEmailQuota } from "@/lib/email-limits";

// GET /api/teacher/email-quota
// The signed-in teacher's remaining email budget (per day and per month), used
// by the compose UI to show how many emails are left and disable the channel.
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const quota = await getTeacherEmailQuota(teacher.userId, {
    emailDailyLimit: teacher.emailDailyLimit,
    emailMonthlyLimit: teacher.emailMonthlyLimit,
  });

  return NextResponse.json(quota);
}
