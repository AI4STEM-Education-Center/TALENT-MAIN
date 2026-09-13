import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/notifications/read
// Body: { id } to mark one notification read, or { all: true } to mark all.
// Scoped to the signed-in user so a user can only mark their own notifications.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, all } = await req.json().catch(() => ({}));
  const now = new Date();

  if (all === true) {
    await prisma.notification.updateMany({
      where: { userId: session.user.id, readAt: null },
      data: { readAt: now },
    });
    return NextResponse.json({ ok: true });
  }

  if (typeof id === "string" && id) {
    await prisma.notification.updateMany({
      where: { id, userId: session.user.id, readAt: null },
      data: { readAt: now },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { error: "Provide a notification id or all: true." },
    { status: 400 },
  );
}
