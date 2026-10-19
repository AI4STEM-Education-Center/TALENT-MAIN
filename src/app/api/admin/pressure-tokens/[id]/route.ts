import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

/**
 * Revokes a token. The row is kept so the admin list still shows when the
 * credential existed and when it was last used; ingestion rejects it from the
 * next request onwards.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  try {
    const { id } = await params;
    const existing = await prisma.pressureResultToken.findUnique({
      where: { id },
      select: { id: true, revokedAt: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Token not found." }, { status: 404 });
    }
    if (existing.revokedAt) {
      return NextResponse.json({ ok: true });
    }

    await prisma.pressureResultToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logApiError("ADMIN_PRESSURE_TOKEN_DELETE", error);
    return NextResponse.json(
      { error: "Could not revoke ingestion token." },
      { status: 500 },
    );
  }
}
