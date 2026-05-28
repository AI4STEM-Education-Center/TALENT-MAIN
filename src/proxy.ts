import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

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
  const session = req.auth;

  // Public routes
  const publicRoutes = ["/", "/login", "/register"];
  const isPublicRoute = publicRoutes.includes(pathname);
  const isInviteRoute = pathname.startsWith("/invite/");
  const isApiAuth = pathname.startsWith("/api/auth");
  // Invitation API must be public: unauthenticated students need to validate
  // tokens and POST to enroll (signup flow) before they have a session.
  const isApiInvitation = pathname.startsWith("/api/invitations/");

  if (isPublicRoute || isInviteRoute || isApiAuth || isApiInvitation) {
    return NextResponse.next();
  }

  // Not authenticated — redirect to login
  if (!session) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const role = session.user?.role;

  // Role-based path guards
  if (pathname.startsWith("/teacher") && role !== "TEACHER") {
    return NextResponse.redirect(new URL("/student", req.url));
  }
  if (pathname.startsWith("/student") && role !== "STUDENT") {
    return NextResponse.redirect(new URL("/teacher", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|public).*)",
  ],
};
