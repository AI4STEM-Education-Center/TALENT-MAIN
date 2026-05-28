import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET: Look up a student's name by orgDefinedId, scoped to the class tied to this invitation token.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const { searchParams } = new URL(req.url);
  const rawId = searchParams.get("orgDefinedId") || "";
  const orgDefinedId = rawId.replace(/^#/, "").trim();

  if (!orgDefinedId) {
    return NextResponse.json({ found: false, error: "81 number is required." }, { status: 400 });
  }

  // Validate the invitation token
  const invitation = await prisma.invitation.findUnique({
    where: { token },
  });

  if (!invitation || !invitation.active) {
    return NextResponse.json({ found: false, error: "Invalid invitation." }, { status: 404 });
  }
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    return NextResponse.json({ found: false, error: "Invitation expired." }, { status: 410 });
  }
  if (invitation.maxUses && invitation.usedCount >= invitation.maxUses) {
    return NextResponse.json({ found: false, error: "Invitation limit reached." }, { status: 410 });
  }

  // Look up the orgDefinedId in this class's student list
  const entry = await prisma.classStudentList.findUnique({
    where: {
      classId_orgDefinedId: {
        classId: invitation.classId,
        orgDefinedId,
      },
    },
  });

  if (!entry) {
    return NextResponse.json({ found: false });
  }

  if (entry.isRegistered) {
    return NextResponse.json({
      found: false,
      error: "This 81 number is already registered.",
    });
  }

  return NextResponse.json({
    found: true,
    firstName: entry.firstName,
    lastName: entry.lastName,
  });
}
