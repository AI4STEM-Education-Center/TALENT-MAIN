import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { appOrigin } from "@/lib/app-url";
import { toTeacherCodeView } from "@/lib/teacher-registration-codes";
import { parseBody, teacherCodeUpdateSchema } from "@/lib/validation";
import { logApiError, logSystemEvent } from "@/lib/system-log";

export const runtime = "nodejs";

/**
 * PATCH /api/admin/teacher-codes/[id] — revoke a code, or put a revoked one
 * back in service. Revoking is the reversible action, which is why it flips a
 * flag instead of deleting the row: the usedCount and the label stay readable
 * as a record of what was handed out.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const parsed = parseBody(teacherCodeUpdateSchema, await req.json());
    if (!parsed.ok) return parsed.response;

    const existing = await prisma.teacherRegistrationCode.findUnique({
      where: { id },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "Registration code not found." },
        { status: 404 },
      );
    }

    const row = await prisma.teacherRegistrationCode.update({
      where: { id },
      data: { active: parsed.data.active },
    });

    void logSystemEvent({
      category: "AUTH",
      type: parsed.data.active
        ? "TEACHER_CODE_RESTORED"
        : "TEACHER_CODE_REVOKED",
      message: `Teacher registration code ${parsed.data.active ? "restored" : "revoked"}${
        row.label ? ` (${row.label})` : ""
      }.`,
      userId: session.user.id,
      metadata: { codeId: row.id, usedCount: row.usedCount },
    });

    return NextResponse.json(toTeacherCodeView(row, appOrigin(req)));
  } catch (error) {
    logApiError("ADMIN_TEACHER_CODES_PATCH", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/admin/teacher-codes/[id] — drop a code from the list entirely.
 * Teachers already registered with it keep their accounts; only the record of
 * the code goes away, so the panel steers admins to revoke instead.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const deleted = await prisma.teacherRegistrationCode.deleteMany({
      where: { id },
    });
    if (deleted.count === 0) {
      return NextResponse.json(
        { error: "Registration code not found." },
        { status: 404 },
      );
    }

    void logSystemEvent({
      category: "AUTH",
      type: "TEACHER_CODE_DELETED",
      message: "Teacher registration code deleted.",
      userId: session.user.id,
      metadata: { codeId: id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logApiError("ADMIN_TEACHER_CODES_DELETE", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
