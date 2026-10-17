import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { canViewAdminData, isAdmin, isResearcher } from "@/lib/roles";
import { logSystemEvent } from "@/lib/system-log";

/**
 * Server-side gates for the admin dashboard and the /api/admin/* surface.
 *
 * Two tiers:
 * - ADMIN-only ("config / actions"): settings, secrets, invite codes, backups,
 *   e-mail sending and EVERY state-changing request. Use requireAdminApi /
 *   requireAdminPage.
 * - Admin-data readers (ADMIN + RESEARCHER): read-only research data such as
 *   users, classes, content, surveys, consent records and logs. Use
 *   requireAdminDataReader / requireAdminDataPage — and only from GET
 *   handlers. A route whose GET is open to researchers must still gate its
 *   POST/PUT/PATCH/DELETE with requireAdminApi.
 *
 * API helpers resolve to the session, or to a ready-made response the handler
 * returns as-is: 401 when nobody is signed in, 403 for a signed-in user of
 * the wrong role.
 *
 * Usage:
 *   const session = await requireAdminDataReader();
 *   if (session instanceof Response) return session;
 */

export type AuthedSession = Session & { user: Session["user"] };

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

async function gateApi(
  allowed: (role: unknown) => boolean,
): Promise<AuthedSession | NextResponse> {
  const session = await auth();
  if (!session?.user) return unauthorized();
  if (!allowed(session.user.role)) return forbidden();
  return session as AuthedSession;
}

/** ADMIN only. For config routes and every mutation. */
export function requireAdminApi(): Promise<AuthedSession | NextResponse> {
  return gateApi(isAdmin);
}

/** ADMIN or RESEARCHER. For read-only (GET) admin-data routes only. */
export function requireAdminDataReader(): Promise<
  AuthedSession | NextResponse
> {
  return gateApi(canViewAdminData);
}

/**
 * Page gate for admin-only server components. A signed-in user of the wrong
 * role goes to the admin overview (researchers) or the login form; the proxy
 * normally redirects them first, so this is defence in depth.
 */
export async function requireAdminPage(): Promise<AuthedSession> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (isResearcher(session.user.role)) redirect("/admin");
  if (!isAdmin(session.user.role)) redirect("/login");
  return session as AuthedSession;
}

/** Page gate for read-only admin-data server components (ADMIN + RESEARCHER). */
export async function requireAdminDataPage(): Promise<AuthedSession> {
  const session = await auth();
  if (!session?.user || !canViewAdminData(session.user.role))
    redirect("/login");
  return session as AuthedSession;
}

/**
 * Audit trail for research-data downloads (the research export ZIP and the
 * CSV downloads). Recorded for admins and research scientists alike, with the
 * downloader's id and role, so an admin can see in /admin/logs who took which
 * dataset. Best-effort like every system-log write.
 */
export async function logDataExport(
  actor: { id: string; role: string; email?: string | null },
  dataset: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await logSystemEvent({
    category: "AUDIT",
    type: "DATA_EXPORT",
    message: `${actor.role} ${actor.email || actor.id} downloaded ${dataset}`,
    userId: actor.id,
    metadata: { dataset, role: actor.role, ...metadata },
  });
}
