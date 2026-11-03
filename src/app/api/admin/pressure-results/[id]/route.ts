import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

/**
 * Deletes one stored pressure result.
 *
 * Unlike a revoked ingestion token, there is nothing worth keeping in a result
 * that should not be there: a wrong row is not history, it is a false reading
 * that skews the pass/fail cards and the p95 trend for every window that
 * contains it. So this is a real delete rather than a soft one.
 *
 * It exists because results published before the threshold-inversion fix were
 * stored with their verdict backwards — passing thresholds recorded as failures
 * and genuine breaches omitted — and there was no way to remove them.
 *
 * Admin-only, like every other route in this directory. Ingestion is a separate
 * surface authenticated by bearer token and deliberately cannot reach this.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const existing = await prisma.pressureTestResult.findUnique({
      where: { id },
      select: { id: true, runId: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Result not found." }, { status: 404 });
    }

    await prisma.pressureTestResult.delete({ where: { id } });
    return NextResponse.json({ ok: true, runId: existing.runId });
  } catch (error) {
    logApiError("ADMIN_PRESSURE_RESULT_DELETE", error);
    return NextResponse.json(
      { error: "Could not delete pressure result." },
      { status: 500 },
    );
  }
}
