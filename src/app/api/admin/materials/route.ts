import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await prisma.learningMaterial.findMany({
    where: { teacherId: { not: null } },
    orderBy: { createdAt: "desc" },
    include: {
      teacher: { select: { user: { select: { username: true, firstName: true, lastName: true, email: true } } } },
      class: { select: { name: true } },
    },
  });

  return NextResponse.json({ materials: items });
}
