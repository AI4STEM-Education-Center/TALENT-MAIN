import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminDataReader } from "@/lib/admin-access";
import { logApiError } from "@/lib/system-log";

export async function GET() {
  try {
    const session = await requireAdminDataReader();
    if (session instanceof Response) return session;

    const [students, teachers, admins, classes] = await Promise.all([
      prisma.user.count({ where: { role: "STUDENT" } }),
      prisma.user.count({ where: { role: "TEACHER" } }),
      prisma.user.count({ where: { role: "ADMIN" } }),
      prisma.class.count(),
    ]);

    return NextResponse.json({
      students,
      teachers,
      admins,
      classes,
    });
  } catch (error) {
    logApiError("ADMIN_STATS_GET", error);
    return NextResponse.json({ error: "Internal Error" }, { status: 500 });
  }
}
