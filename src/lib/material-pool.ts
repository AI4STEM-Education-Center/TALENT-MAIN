import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  buildPageStorageKey,
  buildStorageKey,
  copyS3Object,
  deleteS3Objects,
} from "@/lib/storage";

/**
 * Copy a processed learning material into either the global pool or one of a
 * teacher's classes. Files and page images receive new S3 keys, so either copy
 * can later be reprocessed or deleted without mutating the other.
 */
export async function deepCopyLearningMaterial(
  sourceMaterialId: string,
  target: {
    teacherId: string | null;
    classId: string | null;
    topicId?: string | null;
  },
) {
  const source = await prisma.learningMaterial.findUnique({
    where: { id: sourceMaterialId },
    include: { topic: true, pages: { orderBy: { pageNumber: "asc" } } },
  });
  if (!source) return null;

  let topicId = target.topicId ?? null;
  if (target.topicId) {
    const targetTopic = await prisma.topic.findFirst({
      where: {
        id: target.topicId,
        teacherId: target.teacherId,
        contentType: "MATERIAL",
      },
      select: { id: true },
    });
    if (!targetTopic)
      throw new Error("Material tag not found in the target scope.");
  }
  if (
    target.topicId === undefined &&
    source.topic?.contentType === "MATERIAL"
  ) {
    const matchingTopic = await prisma.topic.findFirst({
      where: {
        teacherId: target.teacherId,
        contentType: "MATERIAL",
        name: source.topic.name,
      },
    });
    topicId =
      matchingTopic?.id ??
      (
        await prisma.topic.create({
          data: {
            teacherId: target.teacherId,
            name: source.topic.name,
            order: source.topic.order,
            contentType: "MATERIAL",
          },
        })
      ).id;
  }

  const id = randomUUID();
  const storageScope = target.teacherId ?? "pool";
  const classScope = target.classId ?? "pool";
  const storageKey = buildStorageKey(
    storageScope,
    classScope,
    id,
    source.originalName,
  );
  const pageCopies = source.pages.map((page) => ({
    source: page,
    storageKey: buildPageStorageKey(
      storageScope,
      classScope,
      id,
      page.pageNumber,
    ),
  }));
  const copiedKeys: string[] = [];

  try {
    copiedKeys.push(storageKey, ...pageCopies.map((page) => page.storageKey));
    await Promise.all([
      copyS3Object(source.bucket, source.storageKey, storageKey),
      ...pageCopies.map((page) =>
        copyS3Object(source.bucket, page.source.storageKey, page.storageKey),
      ),
    ]);

    return await prisma.learningMaterial.create({
      data: {
        id,
        teacherId: target.teacherId,
        classId: target.classId,
        topicId,
        sourceMaterialId: source.id,
        title: source.title,
        originalName: source.originalName,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
        storageKey,
        bucket: source.bucket,
        uploadStatus: source.uploadStatus,
        processingStatus: source.processingStatus,
        folder: source.folder,
        totalPages: source.totalPages,
        processedPages: source.processedPages,
        errorMessage: source.errorMessage,
        batchDescription: source.batchDescription,
        batchKeyConcepts: source.batchKeyConcepts,
        aiModel: source.aiModel,
        aiProvider: source.aiProvider,
        aiServiceTier: source.aiServiceTier,
        aiThinkingLevel: source.aiThinkingLevel,
        aiTtftMs: source.aiTtftMs,
        aiTokens: source.aiTokens,
        aiTotalMs: source.aiTotalMs,
        pages: {
          create: pageCopies.map(
            ({ source: page, storageKey: pageStorageKey }) => ({
              pageNumber: page.pageNumber,
              storageKey: pageStorageKey,
              needed: page.needed,
              keyConcept: page.keyConcept,
              description: page.description,
            }),
          ),
        },
        ...(target.classId
          ? { classLinks: { create: { classId: target.classId } } }
          : {}),
      },
      include: { topic: true, _count: { select: { pages: true } } },
    });
  } catch (error) {
    if (copiedKeys.length > 0) {
      await deleteS3Objects(source.bucket, copiedKeys).catch(() => {});
    }
    throw error;
  }
}
