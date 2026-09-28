import NextAuth, { type NextAuthConfig } from "next-auth";
import { credentialVersion } from "./session-credentials";
import Credentials from "next-auth/providers/credentials";
import { decode, encode } from "next-auth/jwt";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { logSystemEvent } from "@/lib/system-log";
import { getUserConsentClaim, isConsentRole } from "@/lib/consent";
import {
  isSessionExpired,
  remainingSessionSeconds,
  sessionExpiresAt,
  shouldRememberComputer,
  THIRTY_DAYS_SECONDS,
} from "@/lib/auth-session";

const useSecureCookies = process.env.NODE_ENV === "production";
const sessionCookieName = `${useSecureCookies ? "__Secure-" : ""}authjs.session-token`;

/**
 * Stamp `consentVersion`/`consentDecision` onto a JWT from the database.
 * ADMIN accounts (not a consent role) always get null — the platform-access
 * gate in src/proxy.ts only ever checks TEACHER, and STUDENT never blocks
 * navigation on this claim either way. Read once here rather than in
 * src/proxy.ts on every request — see the rationale in getUserConsentClaim.
 *
 * `consentDecision` is AGREE/DECLINE, null when the user still owes an answer
 * on the active form, or NOT_REQUIRED when the role has no published form at
 * all — the proxy must treat those last two differently (consent-claim.ts).
 */
async function stampConsentClaim(
  token: Record<string, unknown>,
): Promise<void> {
  const role = token.role;
  if (!isConsentRole(role) || typeof token.id !== "string") {
    token.consentVersion = null;
    token.consentDecision = null;
    return;
  }
  const claim = await getUserConsentClaim(token.id, role);
  token.consentVersion = claim?.version ?? null;
  token.consentDecision = claim?.decision ?? null;
}

export const authConfig = {
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        identifier: { label: "Email or Username", type: "text" },
        password: { label: "Password", type: "password" },
        remember: { label: "Remember this computer", type: "checkbox" },
      },
      async authorize(credentials, request) {
        const identifier = credentials?.identifier;
        const password = credentials?.password;
        if (
          typeof identifier !== "string" ||
          typeof password !== "string" ||
          !identifier.trim() ||
          identifier.length > 200 ||
          !password ||
          password.length > 200
        )
          return null;
        const normalizedIdentifier = identifier.trim().toLowerCase();

        const ip = request instanceof Request ? clientIp(request) : null;

        // Throttle password brute force per IP. Over the limit we behave like a
        // failed login (return null) rather than surfacing a distinct error.
        if (process.env.NODE_ENV !== "test" && ip !== null) {
          const { allowed } = checkRateLimit(`login:${ip}`, 10, 60_000);
          if (!allowed) {
            // Record the throttling at most once per window per IP (via a
            // second limiter bucket) so a brute-force run can't flood the log.
            if (checkRateLimit(`login-throttle-log:${ip}`, 1, 60_000).allowed) {
              await logSystemEvent({
                category: "AUTH",
                type: "LOGIN_RATE_LIMITED",
                severity: "WARNING",
                message: `Login attempts throttled for ${ip} (possible brute force)`,
                ip,
                metadata: { identifier },
              });
            }
            return null;
          }
        }

        // Find by email OR username
        const user = await prisma.user.findFirst({
          where: {
            OR: [
              { email: normalizedIdentifier },
              { username: normalizedIdentifier },
            ],
          },
        });

        if (!user) {
          await logSystemEvent({
            category: "AUTH",
            type: "LOGIN_FAILED",
            severity: "WARNING",
            message: `Failed login: no account matches "${identifier}"`,
            ip,
            metadata: { identifier, reason: "unknown_user" },
          });
          return null;
        }

        const isValid = await bcrypt.compare(password, user.hashedPassword);
        if (!isValid) {
          await logSystemEvent({
            category: "AUTH",
            type: "LOGIN_FAILED",
            severity: "WARNING",
            message: `Failed login: wrong password for ${user.username}`,
            userId: user.id,
            ip,
            metadata: { identifier, reason: "wrong_password" },
          });
          return null;
        }

        await logSystemEvent({
          category: "AUTH",
          type: "LOGIN_SUCCESS",
          message: `${user.username} (${user.role}) signed in`,
          userId: user.id,
          ip,
        });

        return {
          id: user.id,
          email: user.email,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          credentialVersion: credentialVersion(user.hashedPassword),
          sessionExpiresAt: sessionExpiresAt(
            shouldRememberComputer(credentials?.remember),
          ),
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        token.id = user.id;
        token.credentialVersion = user.credentialVersion;
        token.role = user.role;
        token.username = (user as { username: string }).username;
        token.firstName = (user as { firstName: string }).firstName;
        token.lastName = (user as { lastName: string }).lastName;
        token.sessionExpiresAt =
          (user as { sessionExpiresAt?: number }).sessionExpiresAt ??
          sessionExpiresAt(false);
        await stampConsentClaim(token);
      }

      // The deadline is absolute: polling /api/auth/session or navigating to a
      // new page must never turn a one-day login into a rolling 30-day login.
      // Tokens issued before this policy intentionally fail closed.
      if (!user && isSessionExpired(token.sessionExpiresAt)) return null;

      // A JWT is only a reference to a live account. Recheck its credential
      // version and role so deleting/demoting an account or changing its password
      // immediately revokes old access, rather than waiting up to thirty days.
      if (!user) {
        if (
          typeof token.id !== "string" ||
          typeof token.credentialVersion !== "string"
        )
          return null;
        const fresh = await prisma.user.findUnique({
          where: { id: token.id },
          select: {
            firstName: true,
            lastName: true,
            username: true,
            email: true,
            role: true,
            hashedPassword: true,
          },
        });
        if (
          !fresh ||
          credentialVersion(fresh.hashedPassword) !== token.credentialVersion ||
          fresh.role !== token.role
        )
          return null;
        token.firstName = fresh.firstName;
        token.lastName = fresh.lastName;
        token.username = fresh.username;
        token.email = fresh.email;
      }

      // Consent submission requests a refresh; claims always come from the DB.
      if (trigger === "update") await stampConsentClaim(token);

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.username = token.username as string;
        session.user.firstName = token.firstName as string;
        session.user.lastName = token.lastName as string;
        session.user.consentVersion =
          (token.consentVersion as string | null | undefined) ?? null;
        session.user.consentDecision =
          (token.consentDecision as string | null | undefined) ?? null;
      }
      return {
        ...session,
        expires: new Date(
          (token.sessionExpiresAt as number) * 1000,
        ).toISOString(),
      };
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    // The cookie must be able to survive the longest opt-in lifetime. The JWT
    // callback and custom encoder enforce each login's shorter absolute limit.
    maxAge: THIRTY_DAYS_SECONDS,
  },
  jwt: {
    encode(params) {
      return encode({
        ...params,
        maxAge:
          typeof params.token?.sessionExpiresAt === "number"
            ? remainingSessionSeconds(params.token.sessionExpiresAt)
            : params.maxAge,
      });
    },
    decode,
  },
  // Pin cookie security instead of inferring it from each reverse-proxied
  // request. This keeps Safari on one cookie name across page navigations.
  useSecureCookies,
  cookies: {
    sessionToken: {
      name: sessionCookieName,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
      },
    },
  },
  trustHost: true,
} satisfies NextAuthConfig;

export const { handlers, signIn, signOut, auth } = NextAuth(authConfig);
