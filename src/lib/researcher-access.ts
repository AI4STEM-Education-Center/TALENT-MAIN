/**
 * Which admin-dashboard pages a RESEARCHER ("Research scientist") may open.
 *
 * Research scientists get read-only access to the admin DATA pages (people,
 * classes, content, surveys, consent records, feedback, chats, logs) but never
 * to the CONFIG pages (AI config, e-mail/SMTP, backups, invite codes, pressure
 * tests, system-resource monitoring, consent-form publishing/settings,
 * research e-mail sending). The
 * proxy redirects them off anything not listed here and the sidebar only
 * links to what is listed.
 *
 * This is navigation only — every API route enforces its own role check
 * (src/lib/admin-access.ts), and mutations stay ADMIN-only even on the pages
 * listed here.
 *
 * Pure and client-safe so the proxy (edge) and the sidebar can share it.
 */

/** Pages a researcher may open, including every sub-page beneath them. */
const RESEARCHER_ADMIN_PREFIXES = [
  "/admin/classes",
  "/admin/usage",
  "/admin/quizzes",
  "/admin/material-pool",
  "/admin/pool-submissions",
  "/admin/simulations",
  "/admin/materials",
  "/admin/concepts",
  "/admin/consent-requests",
  "/admin/research-export",
  "/admin/surveys",
  "/admin/feedback",
  "/admin/assistant-chats",
  "/admin/users",
  "/admin/logs",
  "/admin/resource-engagement",
  "/admin/session-replays",
] as const;

/**
 * Pages a researcher may open whose sub-pages are admin-only: the consent
 * records list (but not /admin/consent/forms or /settings) and the research
 * pool (but not its /email sender).
 */
const RESEARCHER_ADMIN_EXACT = [
  "/admin",
  "/admin/consent",
  "/admin/research-pool",
] as const;

export function isResearcherAdminPath(pathname: string): boolean {
  // Trailing slashes are not significant for matching.
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if ((RESEARCHER_ADMIN_EXACT as readonly string[]).includes(path)) return true;
  return RESEARCHER_ADMIN_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** Shown at the top of every admin page a researcher opens. */
export const RESEARCHER_VIEW_ONLY_NOTICE =
  "Research scientist access — view only";
