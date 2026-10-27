import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminApi } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";
import { logApiError, logSystemEvent } from "@/lib/system-log";

export const runtime = "nodejs";
const bodySchema = z.object({ excluded: z.boolean() }).strict();

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { excluded: boolean }." },
      { status: 400 },
    );
  }
  const { id } = await params;
  try {
    const row = await prisma.class.update({
      where: { id },
      data: {
        researchExcluded: parsed.data.excluded,
        researchExcludedAt: parsed.data.excluded ? new Date() : null,
        researchExcludedById: parsed.data.excluded ? session.user.id : null,
      },
      select: { id: true, researchExcluded: true, researchExcludedAt: true },
    });
    await logSystemEvent({
      category: "AUDIT",
      type: "CLASS_RESEARCH_EXCLUSION_UPDATED",
      message: `Class ${id} research exclusion ${row.researchExcluded ? "enabled" : "disabled"}.`,
      userId: session.user.id,
      metadata: { classId: id, researchExcluded: row.researchExcluded },
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
    logApiError("ADMIN_CLASS_RESEARCH_PATCH", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
