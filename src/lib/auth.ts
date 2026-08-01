import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { logSystemEvent } from "@/lib/system-log";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        identifier: { label: "Email or Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const identifier = credentials?.identifier as string | undefined;
        const password = credentials?.password as string | undefined;

        if (!identifier || !password) return null;

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
              { email: identifier.toLowerCase() },
              { username: identifier.toLowerCase() },
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
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role: string }).role;
        token.username = (user as { username: string }).username;
        token.firstName = (user as { firstName: string }).firstName;
        token.lastName = (user as { lastName: string }).lastName;
      }

      // The profile page calls useSession().update() after saving so the
      // sidebar reflects a renamed account without a re-login. Re-read from the
      // database rather than trusting the client-supplied patch.
      if (trigger === "update" && token.id) {
        const fresh = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { firstName: true, lastName: true, username: true, email: true, role: true },
        });
        if (fresh) {
          token.firstName = fresh.firstName;
          token.lastName = fresh.lastName;
          token.username = fresh.username;
          token.email = fresh.email;
          token.role = fresh.role;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.username = token.username as string;
        session.user.firstName = token.firstName as string;
        session.user.lastName = token.lastName as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  trustHost: true,
});
