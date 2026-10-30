import { NextResponse, type NextRequest } from "next/server";
import {
  getStudentPause,
  DEFAULT_PAUSE_MESSAGE,
  PLATFORM_PAUSED_CODE,
} from "@/lib/class-access-pause";
import { prisma } from "@/lib/prisma";
import { logApiError } from "@/lib/system-log";
import { readBoundedText, BODY_TOO_LARGE } from "@/lib/request-body";

type Session = { user?: { id?: string; role?: string } } | null;
const within = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`);

/** Exempt identity/consent, not resource telemetry paths ending in /sessions. */
export function isPauseExempt(path: string) {
  return (
    within(path, "/api/auth") ||
    within(path, "/api/consent") ||
    path === "/api/student/access" ||
    path === "/student/paused" ||
    within(path, "/api/session") ||
    within(path, "/api/sessions")
  );
}

export function platformPausedResponse(message = DEFAULT_PAUSE_MESSAGE) {
  return NextResponse.json(
    { error: message, code: PLATFORM_PAUSED_CODE },
    {
      status: 403,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}

function blockedResponse(
  req: NextRequest,
  message: string,
  fullyPaused: boolean,
) {
  const path = req.nextUrl.pathname;
  // API callers always get JSON, even with Accept: text/html (e.g. iframes).
  if (path.startsWith("/api/")) return platformPausedResponse(message);
  const document =
    req.headers.get("sec-fetch-mode") === "navigate" ||
    (req.headers.get("accept") ?? "").includes("text/html");
  if (!document && req.headers.get("sec-fetch-mode") === "cors")
    return platformPausedResponse(message);
  // A mixed-class student must not land on a page claiming all access is paused.
  return NextResponse.redirect(
    new URL(fullyPaused ? "/student/paused" : "/student/classes", req.url),
  );
}

/**
 * One request boundary for ALL student APIs and pages. Scoped resource ids are
 * resolved here too, including attempts whose classId isn't supplied by the
 * caller. Route-level ownership checks still decide whether the resource exists.
 */
export async function guardStudentClassAccess(
  req: NextRequest,
  session: Session,
) {
  if (
    session?.user?.role !== "STUDENT" ||
    !session.user.id ||
    isPauseExempt(req.nextUrl.pathname)
  )
    return null;
  const state = await getStudentPause(session.user.id);
  if (state.paused) return blockedResponse(req, state.message!, true);
  if (!state.classes.some((cls) => cls.disabled)) return null;
  try {
    const message = await disabledRequestMessage(
      req,
      session.user.id,
      state.classes,
    );
    return message ? blockedResponse(req, message, false) : null;
  } catch (error) {
    // Deliberate fail-open, matching the global pause lookup policy.
    logApiError("STUDENT_CLASS_ACCESS_LOOKUP", error);
    return null;
  }
}

async function disabledRequestMessage(
  req: NextRequest,
  userId: string,
  classes: { id: string; disabled: boolean }[],
): Promise<string | null> {
  const path = req.nextUrl.pathname;
  const url = new URL(req.url);
  const ids = new Map<string, string>();
  for (const key of [
    "classId",
    "attemptId",
    "materialId",
    "simulationId",
    "quizId",
  ]) {
    const value = url.searchParams.get(key);
    if (value) ids.set(key, value);
  }
  const classPath = path.match(/^\/(?:api|student)\/classes\/([^/]+)/);
  const attemptPath = path.match(
    /^\/(?:api\/student\/attempts|student\/results)\/([^/]+)/,
  );
  const materialPath = path.match(
    /^\/(?:api\/student|student)\/materials\/([^/]+)/,
  );
  const simulationPath = path.match(/^\/api\/simulations\/([^/]+)/);
  if (classPath) ids.set("classId", decodeURIComponent(classPath[1]));
  if (attemptPath) ids.set("attemptId", decodeURIComponent(attemptPath[1]));
  if (materialPath) ids.set("materialId", decodeURIComponent(materialPath[1]));
  if (simulationPath)
    ids.set("simulationId", decodeURIComponent(simulationPath[1]));

  // Only the quiz/feedback APIs accept class-scoped ids in a body. Do not read
  // arbitrary upload/chat bodies or weaken their existing route-specific caps.
  if (
    (["/api/quiz", "/api/quiz/practice", "/api/feedback"].includes(path) || /^/api/(?:simulations|student/materials)/[^/]+/sessions$/.test(path)) &&
    !["GET", "HEAD"].includes(req.method)
  ) {
    const text = await readBoundedText(req.clone(), 2 * 1024 * 1024);
    if (text === BODY_TOO_LARGE) return DEFAULT_PAUSE_MESSAGE;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* Route owns malformed JSON errors. */
    }
    if (body && typeof body === "object") {
      for (const key of [
        "classId",
        "attemptId",
        "materialId",
        "simulationId",
        "quizId",
      ]) {
        if (typeof body[key] === "string") ids.set(key, body[key]);
      }
    }
  }

  const disabledIds = classes
    .filter((cls) => cls.disabled)
    .map((cls) => cls.id);
  let classId = ids.get("classId");
  const attemptId = ids.get("attemptId");
  if (attemptId) {
    const attempt = await prisma.quizAttempt.findFirst({
      where: { id: attemptId, student: { userId } },
      select: { classId: true },
    });
    const practice = !attempt ? await prisma.quizPracticeAttempt.findFirst({ where: { id: attemptId, studentId: (await prisma.student.findUnique({ where: { userId }, select: { id: true } }))?.id ?? "" }, select: { classId: true } }) : null;
    const archived = !attempt && !practice
      ? await prisma.examResult.findFirst({
          where: { quizAttemptId: attemptId, student: { userId } },
          select: { classId: true },
        })
      : null;
    // The persisted attempt wins over a forged active classId in the body.
    classId = attempt?.classId ?? practice?.classId ?? archived?.classId ?? classId;
  }
  if (classId && disabledIds.includes(classId)) {
    const cls = await prisma.class.findUnique({
      where: { id: classId },
      select: { disabledMessage: true },
    });
    return cls?.disabledMessage?.trim() || DEFAULT_PAUSE_MESSAGE;
  }

  const materialId = ids.get("materialId");
  if (materialId) {
    const links = await prisma.materialClass.findMany({
      where: {
        materialId,
        class: { enrollments: { some: { student: { userId } } } },
      },
      select: { class: { select: { disabledAt: true } } },
    });
    if (links.length && links.every((link) => link.class.disabledAt))
      return DEFAULT_PAUSE_MESSAGE;
  }
  const simulationId = ids.get("simulationId");
  let quizId = ids.get("quizId");
  if (simulationId) {
    const sim = await prisma.questionSimulation.findUnique({
      where: { id: simulationId },
      select: { question: { select: { quizId: true } } },
    });
    quizId = sim?.question.quizId ?? quizId;
  }
  if (quizId && !classId) {
    const assignments = await prisma.classQuiz.findMany({
      where: {
        quizId,
        class: { enrollments: { some: { student: { userId } } } },
      },
      select: { class: { select: { disabledAt: true } } },
    });
    if (assignments.length && assignments.every((row) => row.class.disabledAt))
      return DEFAULT_PAUSE_MESSAGE;
  }
  return null;
}
