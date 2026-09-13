import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/notifications?take=&unreadOnly=
// The signed-in user's in-app notifications (newest first) plus an unread count.
// Powers the student mailbox and the sidebar unread badge.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const takeRaw = Number(url.searchParams.get("take"));
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(Math.floor(takeRaw), 1), 100) : 50;
  const unreadOnly = url.searchParams.get("unreadOnly") === "true";

  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.user.id, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take,
      include: {
        message: {
          select: {
            id: true,
            subject: true,
            body: true,
            createdAt: true,
            sender: { select: { firstName: true, lastName: true } },
            class: { select: { name: true } },
          },
        },
      },
    }),
    prisma.notification.count({ where: { userId: session.user.id, readAt: null } }),
  ]);

  const notifications = items.map((n) => ({
    id: n.id,
    // The notification email links by message id (the same message reaches many
    // students), so the mailbox needs it to open the one that was linked.
    messageId: n.message.id,
    subject: n.message.subject,
    body: n.message.body,
    senderName: `${n.message.sender.firstName} ${n.message.sender.lastName}`.trim(),
    className: n.message.class?.name ?? null,
    createdAt: n.createdAt,
    readAt: n.readAt,
  }));

  return NextResponse.json({ notifications, unreadCount });
}
