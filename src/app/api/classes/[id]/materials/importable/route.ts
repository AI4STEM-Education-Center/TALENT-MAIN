import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ id: classId }, teacher] = await Promise.all([
    params,
    prisma.teacher.findUnique({ where: { userId: session.user.id } }),
  ]);
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  // Materials already linked to the target class — excluded from the importable list.
  const existing = await prisma.materialClass.findMany({
    where: { classId },
    select: { materialId: true },
  });
  const alreadyLinked = new Set(existing.map((e) => e.materialId));

  const materials = await prisma.learningMaterial.findMany({
    where: { teacherId: teacher.id, uploadStatus: "READY" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      classId: true,
      title: true,
      originalName: true,
      totalPages: true,
      createdAt: true,
      class: { select: { id: true, name: true } },
    },
  });

  // Group importable materials under their origin class.
  const groups = new Map<string, { id: string; name: string; materials: unknown[] }>();
  const UNKNOWN_KEY = "__none__";

  for (const m of materials) {
    if (alreadyLinked.has(m.id)) continue;

    const key = m.class?.id ?? UNKNOWN_KEY;
    const name = m.class?.name ?? "Other materials";
    if (!groups.has(key)) {
      groups.set(key, { id: key, name, materials: [] });
    }
    groups.get(key)!.materials.push({
      id: m.id,
      title: m.title,
      originalName: m.originalName,
      totalPages: m.totalPages,
      createdAt: m.createdAt.toISOString(),
    });
  }

  const classes = Array.from(groups.values()).filter((g) => g.materials.length > 0);

  return NextResponse.json({ classes });
}
