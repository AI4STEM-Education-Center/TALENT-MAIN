import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [session, { id }, { name, order }] = await Promise.all([
    auth(),
    params,
    req.json(),
  ]);
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const topic = await prisma.topic.update({
    where: { id },
    data: { name: name?.trim(), order },
  });
  return NextResponse.json(topic);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [session, { id }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await prisma.topic.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
