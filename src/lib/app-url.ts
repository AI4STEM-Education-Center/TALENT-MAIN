/**
 * Absolute origin for links the app emails out (password reset, etc.).
 *
 * Prefers an explicit APP_BASE_URL/AUTH_URL so the link is right regardless of
 * how the request arrived, and otherwise reconstructs it from the proxy
 * headers. Header trust is fine here: src/proxy.ts rejects any request whose
 * Host isn't on the allowlist before a route handler ever runs, so the value
 * can't be attacker-chosen.
 */
export function appOrigin(req: Request): string {
  const configured =
    process.env.APP_BASE_URL ||
    process.env.AUTH_URL ||
    process.env.NEXTAUTH_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the header-derived origin rather than emailing a broken link.
    }
  }

  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) {
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
      (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }

  return new URL(req.url).origin;
}
