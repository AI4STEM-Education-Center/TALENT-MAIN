// Server-side reads for the class syllabus: access checks and the one
// serializer every surface (API routes, pages, assistant tools) goes through,
// so what a student can see is decided in exactly one place.

import type { ClassSyllabus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  parseStringList,
  parseSyllabusContent,
  type SyllabusContent,
} from "@/lib/syllabus";

export type SyllabusStatus =
  "PENDING_UPLOAD" | "EXTRACTING" | "READY" | "FAILED";

/** What an enrolled student may see: the content and nothing about the pipeline. */
export type StudentSyllabusView = {
  classId: string;
  content: SyllabusContent;
  originalName: string | null;
  hasFile: boolean;
  updatedAt: string;
};

/** The owning teacher's view: everything needed to review, edit and retry. */
export type TeacherSyllabusView = {
  id: string;
  classId: string;
  status: SyllabusStatus;
  errorMessage: string | null;
  warnings: string[];
  content: SyllabusContent | null;
  originalName: string | null;
  totalPages: number;
  sizeBytes: number;
  hasFile: boolean;
  /** Whether a finished upload exists to re-run extraction on. */
  canRetry: boolean;
  extractedAt: string | null;
  editedAt: string | null;
  updatedAt: string;
  ai: {
    model: string | null;
    provider: string | null;
    serviceTier: string | null;
    thinkingLevel: string | null;
    ttftMs: number | null;
    tokens: number | null;
    totalMs: number | null;
  };
};

function asStatus(value: string): SyllabusStatus {
  return value === "EXTRACTING" || value === "READY" || value === "FAILED"
    ? value
    : "PENDING_UPLOAD";
}

export function toTeacherView(row: ClassSyllabus): TeacherSyllabusView {
  return {
    id: row.id,
    classId: row.classId,
    status: asStatus(row.status),
    errorMessage: row.errorMessage,
    warnings: parseStringList(row.warnings),
    content: parseSyllabusContent(row.content),
    originalName: row.originalName,
    totalPages: row.totalPages,
    sizeBytes: row.sizeBytes,
    hasFile: row.storageKey !== null,
    canRetry:
      row.sourceRevision !== null && parseStringList(row.pageKeys).length > 0,
    extractedAt: row.extractedAt?.toISOString() ?? null,
    editedAt: row.editedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    ai: {
      model: row.aiModel,
      provider: row.aiProvider,
      serviceTier: row.aiServiceTier,
      thinkingLevel: row.aiThinkingLevel,
      ttftMs: row.aiTtftMs,
      tokens: row.aiTokens,
      totalMs: row.aiTotalMs,
    },
  };
}

/** Null when there is no content yet — students never see a half-built syllabus. */
export function toStudentView(row: ClassSyllabus): StudentSyllabusView | null {
  const content = parseSyllabusContent(row.content);
  if (!content) return null;
  return {
    classId: row.classId,
    content,
    originalName: row.originalName,
    hasFile: row.storageKey !== null,
    updatedAt: (row.editedAt ?? row.extractedAt ?? row.updatedAt).toISOString(),
  };
}

/** The class and its teacher id, only when this teacher-user owns it. */
export async function ownedClass(userId: string, classId: string) {
  return prisma.class.findFirst({
    where: { id: classId, teacher: { userId } },
    select: { id: true, name: true, teacherId: true },
  });
}

/** The class, only when this student-user is enrolled in it. */
export async function enrolledClass(userId: string, classId: string) {
  return prisma.class.findFirst({
    where: {
      id: classId,
      enrollments: { some: { student: { userId } } },
    },
    select: { id: true, name: true, teacherId: true },
  });
}

export function findSyllabus(classId: string) {
  return prisma.classSyllabus.findUnique({ where: { classId } });
}
