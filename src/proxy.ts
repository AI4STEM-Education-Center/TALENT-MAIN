import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/rate-limit";
import { trackRequest } from "@/lib/usage-tracker";
import { isTeacherConsentBlocked } from "@/lib/consent-claim";

const ALLOWED_HOSTS = [
  "dev.ai4talent.org",
  "temp.ai4talent.org",
  "localhost",
  "localhost:3000",
];

export default auth((req) => {
  // --- Host validation: reject requests from unknown domains ---
  const host = (
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    ""
  ).toLowerCase();

  const isAllowedHost =
    host === "ai4talent.org" ||
    host.endsWith(".ai4talent.org") ||
    ALLOWED_HOSTS.includes(host);

  if (!isAllowedHost) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const { pathname } = req.nextUrl;

  // Feed the admin system log's traffic samples (request + unique-IP counts).
  // Counted after host validation so rejected garbage doesn't inflate usage.
  trackRequest(clientIp(req), pathname);

  // --- CSRF defense-in-depth: reject cross-site state-changing API requests ---
  // The session cookie is SameSite=Lax (NextAuth default), which already blocks
  // most cross-site writes; this adds an explicit Origin check on mutating API
  // calls (incl. the public auth/invitation routes). Same-origin browser
  // requests send an Origin matching the host; a mismatch is cross-site.
  // Requests with no Origin (server-to-server, same-origin navigations) are
  // left to the cookie's SameSite protection.
  const method = req.method;
  const isMutation = !!method && !["GET", "HEAD", "OPTIONS"].includes(method);
  if (isMutation && pathname.startsWith("/api/")) {
    const origin = req.headers.get("origin");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = "\0invalid";
      }
      if (originHost !== host) {
        return new NextResponse("Forbidden", { status: 403 });
      }
    }
  }

  const session = req.auth;

  // Public routes
  const publicRoutes = [
    "/",
    "/login",
    "/register",
    "/admin-register",
    // Password recovery: reachable precisely when the user has no session.
    "/forgot-password",
    "/reset-password",
  ];
  const isPublicRoute = publicRoutes.includes(pathname);
  const isInviteRoute = pathname.startsWith("/invite/");
  const isApiAuth = pathname.startsWith("/api/auth");
  // Invitation API must be public: unauthenticated students need to validate
  // tokens and POST to enroll (signup flow) before they have a session.
  const isApiInvitation = pathname.startsWith("/api/invitations/");
  // Deployment-to-deployment routes: the caller is the peer environment's
  // server, which has no session to present. Each route under /api/internal/
  // authenticates its own shared-secret bearer token instead (see
  // src/lib/resource-peer.ts) — session-less here does not mean unauthenticated.
  const isApiInternal = pathname.startsWith("/api/internal/");

  if (isPublicRoute || isInviteRoute || isApiAuth || isApiInvitation || isApiInternal) {
    return NextResponse.next();
  }

  // Not authenticated — redirect to login
  if (!session) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const role = session.user?.role;

  // Role-based path guards. Every dashboard area is listed: the admin pages are
  // client components that fetch from /api/admin/* (which enforce ADMIN on their
  // own), so a missing guard here did not leak data — but it did let any signed-in
  // student or teacher load the admin UI and enumerate the admin surface.
  // Matched exactly rather than by prefix so the public "/admin-register" page
  // can never be swept up by it (that route returns above as a public route
  // today — this keeps the guard correct regardless of that ordering).
  if ((pathname === "/admin" || pathname.startsWith("/admin/")) && role !== "ADMIN") {
    return NextResponse.redirect(new URL(role === "TEACHER" ? "/teacher" : "/student", req.url));
  }
  if (pathname.startsWith("/teacher") && role !== "TEACHER") {
    return NextResponse.redirect(new URL(role === "ADMIN" ? "/admin" : "/student", req.url));
  }
  if (pathname.startsWith("/student") && role !== "STUDENT") {
    return NextResponse.redirect(new URL(role === "ADMIN" ? "/admin" : "/teacher", req.url));
  }

  // --- IRB consent hard-gate: a teacher must agree to the research consent
  // form before using any instructor tool (see docs/plans/consent-compliance-plan.md
  // §2). session.user.consentDecision is a JWT claim stamped at sign-in / on
  // an explicit session refresh (src/lib/auth.ts) — it can lag a few minutes
  // behind a brand-new form version being published, which is an accepted
  // tradeoff so this check stays a cheap JWT read rather than a per-request
  // database query. The client-side ConsentGate (mounted in the dashboard
  // layout) does a fresh, un-cached check on every page load and is what
  // actually renders the form, so that staleness window is short in practice.
  // Students are never redirected here — declining is a complete, valid
  // answer for them, enforced only by the modal appearing until they decide.
  //
  // A deployment with no published TEACHER form gates nobody: the claim is
  // stamped NOT_REQUIRED in that case precisely so this never redirects to a
  // page that has no form to show (which looped — see consent-claim.ts).
  const isConsentRoute = pathname === "/teacher/consent-required" || pathname === "/api/consent";
  if (role === "TEACHER" && !isConsentRoute && isTeacherConsentBlocked(session.user?.consentDecision)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "You must respond to the research consent form before using this feature." },
        { status: 403 }
      );
    }
    if (pathname.startsWith("/teacher")) {
      return NextResponse.redirect(new URL("/teacher/consent-required", req.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|public).*)",
  ],
};
