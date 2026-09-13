import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import { InviteClient } from "./invite-client";

export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");
  const { id } = await params;

  // Only the owning teacher can manage this class's invitations.
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const cls = await prisma.class.findFirst({ where: { id, teacherId: teacher?.id } });
  if (!cls) notFound();

  // Build invite URLs from the request host, mirroring POST /api/invitations so
  // the links are stable across SSR/hydration (no window.origin dependency).
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || "http";
  const appUrl = `${proto}://${host}`;

  const rows = await prisma.invitation.findMany({
    where: { classId: id, active: true },
    orderBy: { createdAt: "desc" },
  });
  const initialInvitations = rows.map((inv) => ({
    id: inv.id,
    token: inv.token,
    url: `${appUrl}/invite/${inv.token}`,
    expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
    maxUses: inv.maxUses,
    usedCount: inv.usedCount,
    active: inv.active,
  }));

  return <InviteClient classId={id} initialInvitations={initialInvitations} />;
}
