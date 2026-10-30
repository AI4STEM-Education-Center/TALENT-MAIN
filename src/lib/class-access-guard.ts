import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStudentPause } from "@/lib/class-access-pause";
import {
  DEFAULT_PAUSE_MESSAGE,
  PAUSED_PAGE_PATH,
  PLATFORM_PAUSED_CODE,
} from "@/lib/platform-paused";
import { logApiError } from "@/lib/system-log";

type Session = { user?: { id?: string; role?: string } } | null;

const within = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`);

/**
 * Paths a paused student must still reach: auth (sign-out, session), consent,
 * the access-status endpoint the paused page polls, and the paused page. This
 * is an allowlist of identity/consent/status only; everything else a student
 * can call is blocked, including resource telemetry such as .../sessions.
 */
export function isPauseExempt(path: string) {
  return (
    within(path, "/api/auth") ||
    within(path, "/api/consent") ||
    path === "/api/student/access" ||
    path === PAUSED_PAGE_PATH
  );
}

/** 403 `{ error, code: "PLATFORM_PAUSED" }`; used by the proxy and routes. */
export function platformPausedResponse(message = DEFAULT_PAUSE_MESSAGE) {
  return NextResponse.json(
    { error: message, code: PLATFORM_PAUSED_CODE },
    { status: 403, headers: { "Cache-Control": "private, no-store" } },
  );
}

/**
 * Per-class check for routes that act on a class id taken from a request body
 * (quiz start/submit, practice). Returns the paused response when the class is
 * disabled, else null. Unlike the proxy guard this also covers a student who
 * still has another active class.
 */
export async function pausedClassResponse(classId: string) {
  const cls = await prisma.class.findUnique({
    where: { id: classId },
    select: { disabledAt: true, disabledMessage: true },
  });
  if (!cls?.disabledAt) return null;
  return platformPausedResponse(cls.disabledMessage?.trim() || undefined);
}

/**
 * Class id carried by the URL itself (path or ?classId=), which needs no body
 * parsing and no DB lookup. Everything else class-scoped (materials,
 * simulations, results, history, quiz bodies) is filtered where the data is
 * read; see docs/features/class-access-pause.md.
 */
function classIdFromUrl(req: NextRequest) {
  const match = req.nextUrl.pathname.match(
    /^\/(?:api|student)\/classes\/([^/]+)/,
  );
  const raw = match?.[1] ?? req.nextUrl.searchParams.get("classId");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The central choke point for the class access pause, called from src/proxy.ts
 * for every request after the public-route check. It is path-agnostic: any
 * /api/* route (including ones added later) is covered. Returns a response to
 * short-circuit with, or null to continue. Only STUDENT sessions are ever
 * affected; teachers, admins and researchers pass straight through.
 *
 * APIs get a 403 JSON body (never a redirect, which a fetch would follow and
 * then fail to parse); pages redirect, as the proxy's other role guards do.
 */
export async function guardStudentClassAccess(
  req: NextRequest,
  session: Session,
) {
  const userId = session?.user?.id;
  const path = req.nextUrl.pathname;
  if (session?.user?.role !== "STUDENT" || !userId || isPauseExempt(path))
    return null;

  const state = await getStudentPause(userId);
  const isApi = path.startsWith("/api/");
  if (state.paused) {
    return isApi
      ? platformPausedResponse(state.message ?? undefined)
      : NextResponse.redirect(new URL(PAUSED_PAGE_PATH, req.url));
  }

  // Not paused overall. If one of their classes is disabled, still refuse
  // requests aimed at that class by URL.
  const classId = classIdFromUrl(req);
  if (!classId || !state.classes.some((c) => c.id === classId && c.disabled))
    return null;
  try {
    const cls = await prisma.class.findUnique({
      where: { id: classId },
      select: { disabledMessage: true },
    });
    const message = cls?.disabledMessage?.trim() || DEFAULT_PAUSE_MESSAGE;
    return isApi
      ? platformPausedResponse(message)
      : NextResponse.redirect(new URL("/student/classes", req.url));
  } catch (error) {
    // Same fail-open policy as getStudentPause.
    logApiError("STUDENT_CLASS_ACCESS_LOOKUP", error);
    return null;
  }
}
