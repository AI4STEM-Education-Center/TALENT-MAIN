import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor, ownScope } from "@/lib/quiz-access";

import {
  parseJsonBody,
  topicCreateSchema,
  topicUpdateSchema,
  contentDeleteSchema,
} from "@/lib/validation";

type TopicContentType = "QUIZ" | "MATERIAL";

function contentType(value: unknown): TopicContentType | null {
  return value === "QUIZ" || value === "MATERIAL" ? value : null;
}

// Tags are scoped by both owner and content type. A quiz tag can therefore
// never appear in the material picker (and vice versa).

export async function GET(req?: NextRequest) {
  const actor = await getContentActor();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const requestedType =
    contentType(req?.nextUrl.searchParams.get("contentType")) ?? "QUIZ";

  const topics = await prisma.topic.findMany({
    where: { teacherId: ownScope(actor), contentType: requestedType },
    include: { _count: { select: { quizzes: true, learningMaterials: true } } },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(topics);
}

export async function POST(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await parseJsonBody(topicCreateSchema, req);
  if (!parsed.ok) return parsed.response;
  const { name, order, contentType: rawContentType } = parsed.data;
  if (!name?.trim())
    return NextResponse.json(
      { error: "Topic name required." },
      { status: 400 },
    );
  const requestedType =
    rawContentType === undefined ? "QUIZ" : contentType(rawContentType);
  if (!requestedType)
    return NextResponse.json(
      { error: "Invalid content type." },
      { status: 400 },
    );

  const topic = await prisma.topic.create({
    data: {
      name: name.trim(),
      order: order ?? 0,
      contentType: requestedType,
      teacherId: ownScope(actor),
    },
  });
  return NextResponse.json(topic, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await parseJsonBody(topicUpdateSchema, req);
  if (!parsed.ok) return parsed.response;
  const { id, name, order } = parsed.data;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const topic = await prisma.topic.findUnique({ where: { id } });
  if (!topic || !canManage(actor, topic)) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const updated = await prisma.topic.update({
    where: { id },
    data: {
      ...(name && { name: name.trim() }),
      ...(order !== undefined && { order }),
    },
  });
  return NextResponse.json(updated);
}

// DELETE removes only the label. Related quizzes and materials are detached by
// the SetNull relations and their content is never deleted.
export async function DELETE(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = await parseJsonBody(contentDeleteSchema, req);
  if (!parsed.ok) return parsed.response;
  const { id } = parsed.data;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const topic = await prisma.topic.findUnique({ where: { id } });
  if (!topic || !canManage(actor, topic)) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  await prisma.topic.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
