import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminDataReader } from "@/lib/admin-access";
import { logApiError } from "@/lib/system-log";

export async function GET() {
  try {
    const session = await requireAdminDataReader();
    if (session instanceof Response) return session;

    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(users);
  } catch (error) {
    logApiError("ADMIN_USERS_GET", error);
    return NextResponse.json({ error: "Internal Error" }, { status: 500 });
  }
}
