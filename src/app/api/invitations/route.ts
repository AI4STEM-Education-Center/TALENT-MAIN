import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * A fresh invitation token: 32 crypto-random bytes, base64url so it is safe in
 * the `/invite/<token>` path. Anyone holding this can join the class and query
 * the roster-lookup endpoint (which returns student names and emails), so it is
 * generated here rather than by a `cuid()` schema default — see the note on
 * Invitation.token in prisma/schema.prisma.
 */
function newInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { classId, expiresInDays, maxUses } = await req.json();
  if (!classId) return NextResponse.json({ error: "classId required" }, { status: 400 });

  // Verify teacher owns this class
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const cls = await prisma.class.findFirst({ where: { id: classId, teacherId: teacher?.id } });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const expiresAt = expiresInDays
    ? new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000)
    : null;

  const invitation = await prisma.invitation.create({
    data: {
      classId,
      token: newInvitationToken(),
      expiresAt,
      maxUses: maxUses ? Number(maxUses) : null,
    },
  });

  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || "http";
  const appUrl = `${proto}://${host}`;
  return NextResponse.json({
    ...invitation,
    url: `${appUrl}/invite/${invitation.token}`,
  }, { status: 201 });
}
