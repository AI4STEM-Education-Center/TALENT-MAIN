/**
 * Mint Auth.js session cookies directly, so load scenarios never have to log in.
 *
 * WHY. Two hard blockers make "just log the VUs in" the wrong design:
 *
 *   1. src/lib/auth.ts throttles logins to 10 per minute per IP. A load
 *      generator has ONE source IP, so past ten VUs you are measuring the
 *      throttle.
 *   2. bcryptjs at cost 12 is the most expensive operation in the app, and
 *      bcryptjs is pure JS — it never yields the event loop while stretching.
 *      Logging in 200 VUs would swamp every other measurement with hash cost.
 *
 * Login cost is measured deliberately and in isolation by
 * k6/scenarios/login-storm.js, using the `credentials` entries this tool
 * optionally emits.
 *
 * HOW. The app uses `session: { strategy: "jwt" }` with a custom encoder, so a
 * session is entirely self-contained in one encrypted cookie — no server-side
 * session row to insert. Given the target's AUTH_SECRET this tool produces the
 * exact same JWE the app would have issued.
 *
 * Usage:
 *   tsx pressure/tools/mint-sessions.ts --out sessions.json --students 200 --teachers 10
 *   tsx pressure/tools/mint-sessions.ts --out sessions.json --secure   # __Secure- cookie (prod image)
 */

import { encode, decode } from "next-auth/jwt";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, str, num, bool } from "./args";

const CONSENT_NOT_REQUIRED = "NOT_REQUIRED";

type Identity = {
  userId: string;
  username: string;
  role: string;
  token: string;
};

type Bundle = {
  mintedAt: string;
  cookieName: string;
  /** Absolute expiry shared by every token in the bundle, as a Unix timestamp. */
  expiresAt: number;
  students: Identity[];
  teachers: Identity[];
  admins: Identity[];
  /** A published media-bearing quiz and one minted student enrolled in it. */
  mediaTarget: {
    classId: string;
    quizId: string;
    studentUserId: string;
  } | null;
  /** Real identifiers paired with the runner's deliberately invalid password. */
  credentials: Array<{ identifier: string; password: string }>;
  warnings: string[];
};

async function main() {
  const args = parseArgs();

  if (bool(args, "help")) {
    console.log(
      [
        "Mint Auth.js session cookies for the pressure-test harness.",
        "",
        "  --out <file>           where to write the bundle (required)",
        "  --database-url <url>   file: URL of the target's SQLite DB (default: $DATABASE_URL)",
        "  --secret <value>       AUTH_SECRET of the TARGET (default: $AUTH_SECRET)",
        "  --students <n>         how many student identities  (default 200)",
        "  --teachers <n>         how many teacher identities  (default 10)",
        "  --admins <n>           how many admin identities    (default 1)",
        "  --secure               use the __Secure- cookie name (any NODE_ENV=production target)",
        "  --ttl-hours <n>        session lifetime             (default 12)",
        "  --credentials-for <p>  optional username prefix for login-storm identities",
        "  --credentials-password <pw>  password attempted by login-storm (a random invalid value on EC2)",
      ].join("\n"),
    );
    return;
  }

  const outPath = str(args, "out");
  const secret = str(args, "secret", process.env.AUTH_SECRET ?? "");
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is required (--secret or $AUTH_SECRET). It must be the TARGET's secret — " +
        "a token minted with a different secret decodes to nothing and every request is a redirect to /login.",
    );
  }

  const databaseUrl = str(args, "database-url", process.env.DATABASE_URL ?? "");
  if (!databaseUrl)
    throw new Error(
      "DATABASE_URL is required (--database-url or $DATABASE_URL)",
    );

  // The cookie NAME is also the JWE salt (see src/lib/auth.ts: `salt` defaults to
  // the cookie name in Auth.js). Getting it wrong produces a token that decodes
  // to null, which the app reports as "not signed in" — indistinguishable from a
  // bad secret. The production image sets NODE_ENV=production, so it expects the
  // __Secure- prefixed name.
  const cookieName = bool(args, "secure")
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";

  const ttlHours = num(args, "ttl-hours", 12);
  const expiresAt = Math.floor(Date.now() / 1000) + Math.round(ttlHours * 3600);

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl, timeout: 5000 });
  const prisma = new PrismaClient({ adapter });

  const warnings: string[] = [];

  // ─── Consent claims ────────────────────────────────────────────────────────
  // src/proxy.ts hard-gates TEACHERs: isTeacherConsentBlocked() lets through
  // ONLY an explicit AGREE or NOT_REQUIRED. A minted teacher token without a
  // correct claim gets 403 on every /api/ call and a redirect on every page —
  // which in a load report looks like a broken app rather than a broken harness.
  //
  // The claim is read from the database exactly the way getUserConsentClaim
  // does, rather than being faked as AGREE. Faking it would hide a real
  // deployment state (a published form nobody has answered) behind a green run.
  const activeTeacherForm = await getActiveForm(prisma, "TEACHER");
  const activeStudentForm = await getActiveForm(prisma, "STUDENT");

  async function consentClaimFor(userId: string, role: string) {
    const active =
      role === "TEACHER"
        ? activeTeacherForm
        : role === "STUDENT"
          ? activeStudentForm
          : null;
    if (role !== "TEACHER" && role !== "STUDENT")
      return { version: null, decision: null };
    if (!active) return { version: null, decision: CONSENT_NOT_REQUIRED };
    const record = await prisma.consentRecord.findFirst({
      where: { userId, formVersionId: active.id },
      orderBy: { signedAt: "desc" },
      select: { decision: true },
    });
    if (!record) return { version: null, decision: null };
    return { version: active.version, decision: record.decision };
  }

  async function mint(role: string, limit: number): Promise<Identity[]> {
    if (limit <= 0) return [];
    const users = await prisma.user.findMany({
      where: { role },
      // Deterministic ordering so two mints of the same database select the same
      // identities — otherwise "the same" run compares different students.
      orderBy: { id: "asc" },
      take: limit,
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    if (users.length < limit) {
      warnings.push(
        `requested ${limit} ${role} identities but the database only has ${users.length}; ` +
          `scenarios will reuse identities, which concentrates write contention on fewer rows`,
      );
    }

    const identities: Identity[] = [];
    let gatedTeachers = 0;

    for (const user of users) {
      const claim = await consentClaimFor(user.id, user.role);
      if (
        user.role === "TEACHER" &&
        claim.decision !== "AGREE" &&
        claim.decision !== CONSENT_NOT_REQUIRED
      ) {
        gatedTeachers++;
      }

      // Field-for-field what src/lib/auth.ts's jwt callback stamps. A missing
      // `sessionExpiresAt` is fatal: the callback treats a non-number as expired
      // and returns null, silently invalidating the session on first use.
      const token = await encode({
        token: {
          id: user.id,
          role: user.role,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          sessionExpiresAt: expiresAt,
          consentVersion: claim.version,
          consentDecision: claim.decision,
        },
        secret,
        salt: cookieName,
        maxAge: expiresAt - Math.floor(Date.now() / 1000),
      });

      identities.push({
        userId: user.id,
        username: user.username,
        role: user.role,
        token,
      });
    }

    if (gatedTeachers > 0) {
      warnings.push(
        `${gatedTeachers} of ${users.length} teacher identities are CONSENT-GATED: an active TEACHER ` +
          `consent form is published and these accounts have not recorded an AGREE. src/proxy.ts will 403 ` +
          `every /api/ request from them. Teacher steps in the report will be designed_refusals, not load. ` +
          `Either seed AGREE records for the bench teachers or read teacher metrics as invalid for this run.`,
      );
    }

    return identities;
  }

  const students = await mint("STUDENT", num(args, "students", 200));
  const teachers = await mint("TEACHER", num(args, "teachers", 10));
  const admins = await mint("ADMIN", num(args, "admins", 1));

  // Verify the tokens actually decode with the same secret+salt before writing
  // the bundle. This catches a wrong secret, a wrong cookie name, and a
  // maxAge <= 0 here rather than as a wall of 302s halfway through a soak.
  if (students.length + teachers.length + admins.length === 0) {
    throw new Error(
      "no identities were minted — the target database has no users in the requested roles. " +
        "Did the seed run, or is --database-url pointing at an empty file?",
    );
  }
  const sample = students[0] ?? teachers[0] ?? admins[0];
  const decoded = await decode({
    token: sample.token,
    secret,
    salt: cookieName,
  });
  if (!decoded || decoded.id !== sample.userId) {
    throw new Error(
      "self-check FAILED: a freshly minted token did not decode back to its own user",
    );
  }

  const credentials = buildCredentials(args, students, teachers);
  const mediaTarget = await findMediaTarget(prisma, students);
  if (!mediaTarget) {
    warnings.push(
      "no published media-bearing quiz is accessible to the minted students; smoke will skip deterministic media coverage and media-signing will fail clearly",
    );
  }

  const bundle: Bundle = {
    mintedAt: new Date().toISOString(),
    cookieName,
    expiresAt,
    students,
    teachers,
    admins,
    mediaTarget,
    credentials,
    warnings,
  };

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  // 0600: these ARE live session cookies for real accounts in the target
  // database. Anyone who reads this file is signed in as those users until it
  // expires, which is why --ttl-hours defaults to 12 and not to a month.
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2), { mode: 0o600 });

  console.log(
    `minted ${students.length} students, ${teachers.length} teachers, ${admins.length} admins -> ${outPath}`,
  );
  console.log(
    `cookie: ${cookieName}  expires: ${new Date(expiresAt * 1000).toISOString()}`,
  );
  for (const warning of warnings) console.warn(`WARNING: ${warning}`);

  await prisma.$disconnect();
}

/**
 * Byte-for-byte the same query as getActiveConsentVersion in src/lib/consent.ts:
 * `isActive: true` ordered by `createdAt` desc. Deliberately duplicated rather
 * than imported, because importing src/lib/consent.ts would pull in the app's
 * own Prisma singleton and connect to whatever DATABASE_URL the process has —
 * not the `--database-url` this tool was pointed at.
 *
 * If that query ever changes, this must change with it: a mismatch silently
 * stamps a claim the running app disagrees with, and every teacher request 403s.
 */
async function getActiveForm(prisma: PrismaClient, role: string) {
  return prisma.consentFormVersion.findFirst({
    where: { role, isActive: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, version: true },
  });
}

/**
 * login-storm needs identifiers that reach bcrypt, but it does not need a
 * successful sign-in: a deliberately invalid password incurs the same bcrypt
 * comparison cost and then exercises the designed rejection/throttle path.
 * The EC2 runner supplies a unique random-looking invalid password per run.
 */
function buildCredentials(
  args: ReturnType<typeof parseArgs>,
  students: Identity[],
  teachers: Identity[],
): Array<{ identifier: string; password: string }> {
  const password = args.opts["credentials-password"];
  const prefix = args.opts["credentials-for"];
  if (typeof password !== "string") return [];
  const normalizedPrefix = typeof prefix === "string" ? prefix : "";

  return [...students, ...teachers]
    .filter((identity) => identity.username.startsWith(normalizedPrefix))
    .slice(0, 50)
    .map((identity) => ({ identifier: identity.username, password }));
}

/** Find deterministic media coverage that one of the minted students can open. */
async function findMediaTarget(
  prisma: PrismaClient,
  students: Identity[],
): Promise<{ classId: string; quizId: string; studentUserId: string } | null> {
  const userIds = students.map((student) => student.userId);
  if (userIds.length === 0) return null;

  const target = await prisma.classQuiz.findFirst({
    where: {
      published: true,
      class: {
        enrollments: {
          some: { student: { userId: { in: userIds } } },
        },
      },
      quiz: {
        questions: {
          some: {
            OR: [
              { figureStorageKey: { not: null } },
              { options: { some: { imageStorageKey: { not: null } } } },
            ],
          },
        },
      },
    },
    orderBy: { id: "asc" },
    select: {
      classId: true,
      quizId: true,
      class: {
        select: {
          enrollments: {
            where: { student: { userId: { in: userIds } } },
            orderBy: { id: "asc" },
            take: 1,
            select: { student: { select: { userId: true } } },
          },
        },
      },
    },
  });
  const studentUserId = target?.class.enrollments[0]?.student.userId;
  if (!target || !studentUserId) return null;
  return { classId: target.classId, quizId: target.quizId, studentUserId };
}

main().catch((error) => {
  console.error(
    `mint-sessions failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
