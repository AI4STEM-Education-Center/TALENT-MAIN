import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Normalize an incoming limit value: null/""/missing → null (use the global
// default); a positive integer → that value; anything else is invalid.
function normalizeLimit(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined || value === "")
    return { ok: true, value: null };
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return { ok: true, value: Math.floor(n) };
  return { ok: false };
}

// PATCH /api/admin/teachers/[teacherId]/email-limit
// Body: { emailDailyLimit?, emailMonthlyLimit? } — number to override, null to
// reset that cap back to the global default. Only fields present are changed.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ teacherId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { teacherId } = await params;
  const body = await req.json().catch(() => ({}));

  const data: {
    emailDailyLimit?: number | null;
    emailMonthlyLimit?: number | null;
  } = {};

  if ("emailDailyLimit" in body) {
    const r = normalizeLimit(body.emailDailyLimit);
    if (!r.ok)
      return NextResponse.json(
        { error: "Daily limit must be a positive number or empty." },
        { status: 400 },
      );
    data.emailDailyLimit = r.value;
  }
  if ("emailMonthlyLimit" in body) {
    const r = normalizeLimit(body.emailMonthlyLimit);
    if (!r.ok)
      return NextResponse.json(
        { error: "Monthly limit must be a positive number or empty." },
        { status: 400 },
      );
    data.emailMonthlyLimit = r.value;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "No limit fields provided." },
      { status: 400 },
    );
  }

  const exists = await prisma.teacher.findUnique({ where: { id: teacherId } });
  if (!exists)
    return NextResponse.json({ error: "Teacher not found." }, { status: 404 });

  const teacher = await prisma.teacher.update({
    where: { id: teacherId },
    data,
  });

  return NextResponse.json({
    id: teacher.id,
    emailDailyLimit: teacher.emailDailyLimit,
    emailMonthlyLimit: teacher.emailMonthlyLimit,
  });
}
