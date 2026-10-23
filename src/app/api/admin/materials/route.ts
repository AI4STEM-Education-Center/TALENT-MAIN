import { NextRequest, NextResponse } from "next/server";
import { requireAdminDataReader } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await requireAdminDataReader();
  if (session instanceof Response) return session;

  const items = await prisma.learningMaterial.findMany({
    where: { teacherId: { not: null } },
    orderBy: { createdAt: "desc" },
    include: {
      teacher: {
        select: {
          user: {
            select: {
              username: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      },
      class: { select: { name: true } },
    },
  });

  // Flag teacher materials already in the global pool: either an admin copied
  // them in (pool row points back at them) or the teacher imported them from a
  // pool item that still exists.
  const poolMatches = await prisma.learningMaterial.findMany({
    where: {
      teacherId: null,
      OR: [
        { sourceMaterialId: { in: items.map((item) => item.id) } },
        {
          id: {
            in: items.flatMap((item) =>
              item.sourceMaterialId ? [item.sourceMaterialId] : [],
            ),
          },
        },
      ],
    },
    select: { id: true, sourceMaterialId: true },
  });
  const promotedIds = new Set(
    poolMatches.flatMap((pool) =>
      pool.sourceMaterialId ? [pool.sourceMaterialId] : [],
    ),
  );
  const poolIds = new Set(poolMatches.map((pool) => pool.id));

  return NextResponse.json({
    materials: items.map((item) => ({
      ...item,
      inPool:
        promotedIds.has(item.id) ||
        (item.sourceMaterialId !== null && poolIds.has(item.sourceMaterialId)),
    })),
  });
}
