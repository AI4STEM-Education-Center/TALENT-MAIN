import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteS3Objects, listS3Objects, getS3Config, materialPrefixFromStorageKey } from "@/lib/storage";

async function getTeacherClass(userId: string, classId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { userId } });
  if (!teacher) return null;
  return prisma.class.findFirst({ where: { id: classId, teacherId: teacher.id } });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: {
      teacher: { include: { user: true } },
      enrollments: { include: { student: { include: { user: true } } }, orderBy: { joinedAt: "desc" } },
      classTopics: { include: { topic: { include: { subtopics: { orderBy: { order: "asc" } } } } }, orderBy: { topic: { order: "asc" } } },
      invitations: { where: { active: true }, orderBy: { createdAt: "desc" } },
      _count: { select: { enrollments: true } },
    },
  });

  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  return NextResponse.json(cls);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const { name, description } = await req.json();
  const updated = await prisma.class.update({
    where: { id },
    data: { name: name?.trim() || cls.name, description: description?.trim() ?? cls.description },
  });
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  // Capture materials linked to this class before deletion so we can
  // reference-count and clean up S3 for any that become unreferenced.
  const linkedMaterials = await prisma.materialClass.findMany({
    where: { classId: id },
    select: { materialId: true, material: { select: { storageKey: true, bucket: true } } },
  });

  // Deleting the class cascades its MaterialClass links; origin materials survive
  // because LearningMaterial.classId is SetNull (not cascade).
  await prisma.class.delete({ where: { id } });

  let bucket: string | undefined;
  try {
    bucket = getS3Config().bucket;
  } catch {
    bucket = undefined;
  }

  for (const link of linkedMaterials) {
    const remaining = await prisma.materialClass.count({ where: { materialId: link.materialId } });
    if (remaining > 0) continue;

    if (bucket && link.material) {
      try {
        const prefix = materialPrefixFromStorageKey(link.material.storageKey);
        const keys = await listS3Objects(bucket, prefix);
        if (keys.length > 0) {
          await deleteS3Objects(bucket, keys);
        }
      } catch (e) {
        console.error("Failed to delete S3 objects for material:", link.materialId, e);
      }
    }

    await prisma.materialPage.deleteMany({ where: { materialId: link.materialId } });
    await prisma.learningMaterial.delete({ where: { id: link.materialId } }).catch(() => {});
  }

  return NextResponse.json({ success: true });
}
