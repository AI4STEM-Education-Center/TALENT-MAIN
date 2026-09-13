import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, POST } from "@/app/api/invitations/[token]/route";
import { GET as LOOKUP } from "@/app/api/invitations/[token]/lookup/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createStudent, createClass } from "./db";

const mockAuth = vi.mocked(auth);

function req(body?: unknown) {
  return new Request("http://localhost/api/invitations/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;
}
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

async function seedInvite(
  opts: {
    expiresAt?: Date | null;
    maxUses?: number | null;
    usedCount?: number;
    active?: boolean;
  } = {},
) {
  const { teacher } = await createTeacher();
  const cls = await createClass(teacher.id, "Chemistry");
  const invitation = await prisma.invitation.create({
    data: {
      classId: cls.id,
      // Invitation.token carries no schema default any more — it is a bearer
      // credential the API mints with crypto.randomBytes, so every creator
      // (tests included) supplies one explicitly.
      token: randomBytes(32).toString("base64url"),
      expiresAt: opts.expiresAt ?? null,
      maxUses: opts.maxUses ?? null,
      usedCount: opts.usedCount ?? 0,
      active: opts.active ?? true,
    },
  });
  return { cls, invitation };
}

function addRoster(
  classId: string,
  orgDefinedId: string,
  isRegistered = false,
  email = "",
) {
  return prisma.classStudentList.create({
    data: {
      classId,
      orgDefinedId,
      firstName: "Ross",
      lastName: "Tee",
      isRegistered,
      email,
    },
  });
}

function lookupReq(token: string, orgDefinedId: string) {
  const url = `http://localhost/api/invitations/${token}/lookup?orgDefinedId=${encodeURIComponent(orgDefinedId)}`;
  return [new Request(url) as never, ctx(token)] as const;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(null as never); // default: anonymous (signup flow)
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/invitations/[token]", () => {
  it("returns 404 for an unknown token", async () => {
    const res = await GET(req() as never, ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("returns 410 for a deactivated invitation", async () => {
    const { invitation } = await seedInvite({ active: false });
    const res = await GET(req() as never, ctx(invitation.token));
    expect(res.status).toBe(410);
  });

  it("returns 410 for an expired invitation", async () => {
    const { invitation } = await seedInvite({
      expiresAt: new Date("2000-01-01"),
    });
    const res = await GET(req() as never, ctx(invitation.token));
    expect(res.status).toBe(410);
  });

  it("returns 410 when max uses reached", async () => {
    const { invitation } = await seedInvite({ maxUses: 2, usedCount: 2 });
    const res = await GET(req() as never, ctx(invitation.token));
    expect(res.status).toBe(410);
  });

  it("returns class + teacher info for a valid invitation", async () => {
    const { invitation } = await seedInvite();
    const res = await GET(req() as never, ctx(invitation.token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.className).toBe("Chemistry");
    expect(body.teacherName).toBe("Tess Teacher");
  });
});

describe("GET /api/invitations/[token]/lookup", () => {
  it("returns the roster email so the student can confirm it", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904", false, "ross-tee@uga.edu");

    const res = await LOOKUP(...lookupReq(invitation.token, "#811947904"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.firstName).toBe("Ross");
    expect(body.email).toBe("ross-tee@uga.edu");
  });

  it("omits the email for a roster row that has none", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904");

    const res = await LOOKUP(...lookupReq(invitation.token, "811947904"));
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.email).toBeUndefined();
  });

  it("omits an unusable email instead of prefilling it", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904", false, "not-an-email");

    const res = await LOOKUP(...lookupReq(invitation.token, "811947904"));
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.email).toBeUndefined();
  });

  it("reveals nothing for an 81 number outside this class", async () => {
    const { invitation } = await seedInvite();
    const res = await LOOKUP(...lookupReq(invitation.token, "999"));
    const body = await res.json();
    expect(body.found).toBe(false);
    expect(body.email).toBeUndefined();
  });
});

describe("POST /api/invitations/[token] — signup flow", () => {
  const signup = {
    username: "joiner",
    email: "joiner@example.com",
    password: "Abcdef1!",
  };

  it("requires an 81 number", async () => {
    const { invitation } = await seedInvite();
    const res = await POST(req({ ...signup }) as never, ctx(invitation.token));
    expect(res.status).toBe(400);
  });

  it("rejects an 81 number not on the roster", async () => {
    const { invitation } = await seedInvite();
    const res = await POST(
      req({ ...signup, orgDefinedId: "999" }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(404);
  });

  it("rejects an already-registered 81 number", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904", true);
    const res = await POST(
      req({ ...signup, orgDefinedId: "811947904" }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(409);
  });

  it("creates a student, enrolls them, flips the roster, and bumps usedCount", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904");

    // Leading "#" must be stripped before matching the roster.
    const res = await POST(
      req({ ...signup, orgDefinedId: "#811947904" }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(200);

    const user = await prisma.user.findUnique({
      where: { email: "joiner@example.com" },
      include: { student: true },
    });
    expect(user?.role).toBe("STUDENT");
    // First/last name come from the roster entry, not the request.
    expect(user?.firstName).toBe("Ross");

    const enrollment = await prisma.classEnrollment.findFirst({
      where: { classId: cls.id, studentId: user!.student!.id },
    });
    expect(enrollment).not.toBeNull();

    const roster = await prisma.classStudentList.findFirst({
      where: { classId: cls.id },
    });
    expect(roster?.isRegistered).toBe(true);

    const refreshed = await prisma.invitation.findUnique({
      where: { id: invitation.id },
    });
    expect(refreshed?.usedCount).toBe(1);
  });

  it("leaves the roster email alone when the student keeps it", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904", false, "ross-tee@uga.edu");

    const res = await POST(
      req({
        ...signup,
        email: "Ross-Tee@UGA.edu",
        orgDefinedId: "811947904",
      }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(200);

    const roster = await prisma.classStudentList.findFirst({
      where: { classId: cls.id },
    });
    expect(roster?.email).toBe("ross-tee@uga.edu");
  });

  it("moves the roster email to the address the student signed up with", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904", false, "stale@uga.edu");

    const res = await POST(
      req({
        ...signup,
        email: "ross.tee@gmail.com",
        orgDefinedId: "811947904",
      }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(200);

    // The registrar export goes stale; teacher notifications have to reach the
    // mailbox the student actually confirmed.
    const roster = await prisma.classStudentList.findFirst({
      where: { classId: cls.id },
    });
    expect(roster?.email).toBe("ross.tee@gmail.com");
    expect(roster?.isRegistered).toBe(true);
    const user = await prisma.user.findUnique({
      where: { email: "ross.tee@gmail.com" },
    });
    expect(user).not.toBeNull();
  });

  it("rewrites the LMS-only domain before it reaches the roster", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904");

    const res = await POST(
      req({
        ...signup,
        email: "ross-tee@uga.view.usg.edu",
        orgDefinedId: "811947904",
      }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(200);

    const roster = await prisma.classStudentList.findFirst({
      where: { classId: cls.id },
    });
    expect(roster?.email).toBe("ross-tee@uga.edu");
    const user = await prisma.user.findUnique({
      where: { email: "ross-tee@uga.edu" },
    });
    expect(user).not.toBeNull();
  });

  it("rejects an email that cannot receive mail", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904");

    const res = await POST(
      req({
        ...signup,
        email: "not-an-email",
        orgDefinedId: "811947904",
      }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(400);

    const roster = await prisma.classStudentList.findFirst({
      where: { classId: cls.id },
    });
    expect(roster?.isRegistered).toBe(false);
  });

  it("rejects a weak password during signup", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904");
    const res = await POST(
      req({ ...signup, password: "weak", orgDefinedId: "811947904" }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/invitations/[token] — logged-in student", () => {
  it("enrolls the existing authenticated student", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904", false, "student@uga.edu");
    const { user, student } = await createStudent({ email: "student@uga.edu" });
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "STUDENT" },
    } as never);

    const res = await POST(
      req({ orgDefinedId: "811947904" }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(200);

    const enrollment = await prisma.classEnrollment.findFirst({
      where: { classId: cls.id, studentId: student.id },
    });
    expect(enrollment).not.toBeNull();
  });

  it("moves the roster email to the signed-in account's address", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904", false, "stale@uga.edu");
    const { user, student } = await createStudent({
      email: "real-student@uga.edu",
    });
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "STUDENT" },
    } as never);

    const res = await POST(
      req({ orgDefinedId: "811947904" }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(200);

    // The account the student signs in to owns the mailbox, so the roster
    // follows it rather than keeping the registrar's stale address.
    const roster = await prisma.classStudentList.findFirst({
      where: { classId: cls.id },
    });
    expect(roster?.email).toBe("real-student@uga.edu");
    expect(roster?.isRegistered).toBe(true);
    expect(
      await prisma.classEnrollment.count({
        where: { classId: cls.id, studentId: student.id },
      }),
    ).toBe(1);
  });

  it("rejects a logged-in non-student with 403", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904");
    mockAuth.mockResolvedValue({
      user: { id: "whoever", role: "TEACHER" },
    } as never);

    const res = await POST(
      req({ orgDefinedId: "811947904" }) as never,
      ctx(invitation.token),
    );
    expect(res.status).toBe(403);
  });

  it("atomically lets only one student claim a roster identity", async () => {
    const { cls, invitation } = await seedInvite();
    await addRoster(cls.id, "811947904");
    const first = await createStudent();
    const second = await createStudent();
    mockAuth
      .mockResolvedValueOnce({
        user: { id: first.user.id, role: "STUDENT" },
      } as never)
      .mockResolvedValueOnce({
        user: { id: second.user.id, role: "STUDENT" },
      } as never);

    const [one, two] = await Promise.all([
      POST(req({ orgDefinedId: "811947904" }) as never, ctx(invitation.token)),
      POST(req({ orgDefinedId: "811947904" }) as never, ctx(invitation.token)),
    ]);

    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(
      await prisma.classEnrollment.count({ where: { classId: cls.id } }),
    ).toBe(1);
    expect(
      (await prisma.invitation.findUnique({ where: { id: invitation.id } }))
        ?.usedCount,
    ).toBe(1);
  });
});
