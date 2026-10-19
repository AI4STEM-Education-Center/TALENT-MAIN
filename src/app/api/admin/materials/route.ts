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

  return NextResponse.json({ materials: items });
}
