import { NextRequest, NextResponse } from "next/server";
import { classAccessUpdateSchema } from "@/lib/validation";
import { invalidateStudentPauseCache } from "@/lib/class-access-pause";
import { requireAdminApi } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";
import { logApiError, logSystemEvent } from "@/lib/system-log";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  const parsed = classAccessUpdateSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          "Expected { disabled: boolean, message?: string (at most 500 characters) }.",
      },
      { status: 400 },
    );
  }
  const { id } = await params;
  try {
    const row = await prisma.class.update({
      where: { id },
      data: {
        disabledAt: parsed.data.disabled ? new Date() : null,
        disabledMessage: parsed.data.disabled
          ? parsed.data.message?.trim() || null
          : null,
        disabledByUserId: parsed.data.disabled ? session.user.id : null,
      },
      select: { id: true, disabledAt: true, disabledMessage: true },
    });
    invalidateStudentPauseCache();
    await logSystemEvent({
      category: "AUDIT",
      type: "CLASS_ACCESS_UPDATED",
      message: `Class ${id} access ${row.disabledAt ? "disabled" : "enabled"}.`,
      userId: session.user.id,
      metadata: {
        classId: id,
        disabled: !!row.disabledAt,
        disabledMessage: row.disabledMessage,
      },
    });
    return NextResponse.json(row);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Class not found." }, { status: 404 });
    }
    logApiError("ADMIN_CLASS_ACCESS_PATCH", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
