// Resolve the signed-in user into an assistant audience plus the scoped tool
// context. This is the ONLY place the audience and the identity a tool queries
// by are decided, and both come from the session — never from the request body.

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAssistantSettings, type AssistantSettings } from "./config";
import type { AssistantToolContext } from "./types";

export type AssistantSession = {
  ctx: AssistantToolContext;
  settings: AssistantSettings;
};

/**
 * The caller's assistant session, or null when they have no assistant:
 * unauthenticated, an admin (admins configure the assistants rather than use
 * them), or a STUDENT/TEACHER user whose profile row is missing.
 *
 * Returns the settings even when `enabled` is false so callers can distinguish
 * "turned off" from "not your audience" — the widget needs that to stay hidden
 * without an error.
 */
export async function resolveAssistantSession(): Promise<AssistantSession | null> {
  const session = await auth();
  if (!session?.user) return null;

  if (session.user.role === "STUDENT") {
    const student = await prisma.student.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!student) return null;
    return {
      ctx: {
        userId: session.user.id,
        audience: "student",
        studentId: student.id,
        teacherId: null,
      },
      settings: await getAssistantSettings("student"),
    };
  }

  if (session.user.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });
    if (!teacher) return null;
    return {
      ctx: {
        userId: session.user.id,
        audience: "teacher",
        studentId: null,
        teacherId: teacher.id,
      },
      settings: await getAssistantSettings("teacher"),
    };
  }

  return null;
}
