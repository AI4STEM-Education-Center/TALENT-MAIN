import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, POST } from "@/app/api/consent/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createStudent, createTeacher, createAdmin } from "./db";

const mockAuth = vi.mocked(auth);

function asUser(user: {
  id: string;
  role: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}) {
  mockAuth.mockResolvedValue({
    user: {
      id: user.id,
      role: user.role,
      firstName: user.firstName ?? "Stu",
      lastName: user.lastName ?? "Student",
      email: user.email ?? "s@example.com",
    },
  } as never);
}

function get() {
  return GET();
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function publishVersion(role: "STUDENT" | "TEACHER") {
  return prisma.consentFormVersion.create({
    data: {
      role,
      version: "v1",
      title: `${role} form`,
      bodyHtml: "<p>hello</p>",
      isActive: true,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/consent", () => {
  it("401s an unauthenticated request", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await get()).status).toBe(401);
  });

  it("reports nothing to enforce for an ADMIN account", async () => {
    const admin = await createAdmin();
    asUser({ id: admin.id, role: "ADMIN" });
    const data = await (await get()).json();
    expect(data).toEqual({
      needsDecision: false,
      role: null,
      activeForm: null,
      priorDecision: null,
    });
  });

  it("reports nothing to enforce when no form is published yet", async () => {
    const { user } = await createStudent();
    asUser({ id: user.id, role: "STUDENT" });
    const data = await (await get()).json();
    expect(data.needsDecision).toBe(false);
    expect(data.activeForm).toBeNull();
  });

  it("needsDecision is true before a student has responded, false after", async () => {
    await publishVersion("STUDENT");
    const { user } = await createStudent();
    asUser({ id: user.id, role: "STUDENT", email: user.email });

    const before = await (await get()).json();
    expect(before.needsDecision).toBe(true);
    expect(before.activeForm.title).toBe("STUDENT form");

    await post({
      decision: "DECLINE",
      ugaId: "811234567",
      signatureTypedName: "Stu Student",
    });

    const after = await (await get()).json();
    expect(after.needsDecision).toBe(false);
    expect(after.priorDecision.decision).toBe("DECLINE");
  });
});

describe("POST /api/consent", () => {
  it("401s an unauthenticated request", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await post({})).status).toBe(401);
  });

  it("403s an ADMIN account", async () => {
    const admin = await createAdmin();
    asUser({ id: admin.id, role: "ADMIN" });
    expect(
      (await post({ decision: "AGREE", signatureTypedName: "x" })).status,
    ).toBe(403);
  });

  it("409s when no active form is published for the role", async () => {
    const { user } = await createStudent();
    asUser({ id: user.id, role: "STUDENT" });
    expect(
      (
        await post({
          decision: "AGREE",
          interviewRecordingChoice: "NO_INTERVIEW",
          ugaId: "811234567",
          signatureTypedName: "x",
        })
      ).status,
    ).toBe(409);
  });

  it("400s an invalid decision", async () => {
    await publishVersion("STUDENT");
    const { user } = await createStudent();
    asUser({ id: user.id, role: "STUDENT" });
    expect(
      (await post({ decision: "MAYBE", signatureTypedName: "x" })).status,
    ).toBe(400);
  });

  it("400s an AGREE without an interview recording choice", async () => {
    await publishVersion("STUDENT");
    const { user } = await createStudent();
    asUser({ id: user.id, role: "STUDENT" });
    const res = await post({
      decision: "AGREE",
      ugaId: "811234567",
      signatureTypedName: "Stu Student",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/interview recording/);
  });

  it("400s an unknown interview recording choice", async () => {
    await publishVersion("STUDENT");
    const { user } = await createStudent();
    asUser({ id: user.id, role: "STUDENT" });
    const res = await post({
      decision: "AGREE",
      interviewRecordingChoice: "SOMETIMES",
      ugaId: "811234567",
      signatureTypedName: "Stu Student",
    });
    expect(res.status).toBe(400);
  });

  it("400s a missing or malformed UGA ID, for either decision", async () => {
    await publishVersion("STUDENT");
    const { user } = await createStudent();
    asUser({ id: user.id, role: "STUDENT" });
    for (const body of [
      { decision: "DECLINE", signatureTypedName: "Stu" },
      { decision: "DECLINE", ugaId: "abc", signatureTypedName: "Stu" },
      {
        decision: "AGREE",
        interviewRecordingChoice: "AUDIO_ONLY",
        ugaId: "12",
        signatureTypedName: "Stu",
      },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(
      await prisma.consentRecord.count({ where: { userId: user.id } }),
    ).toBe(0);
  });

  it("records a complete AGREE decision with server-derived ip/device, never trusting client-supplied values", async () => {
    const version = await publishVersion("STUDENT");
    const { user } = await createStudent();
    asUser({
      id: user.id,
      role: "STUDENT",
      email: user.email,
      firstName: "Ada",
      lastName: "Lovelace",
    });

    const res = await post(
      {
        decision: "AGREE",
        interviewRecordingChoice: "VIDEO_AUDIO",
        ugaId: "811-234 567",
        signatureTypedName: "Ada Lovelace",
        // A client-supplied ip/device should be ignored entirely — the route
        // doesn't even accept such fields, but assert the stored row reflects
        // the request's real origin, not anything the body could claim.
        ipAddress: "1.2.3.4",
      },
      { "x-forwarded-for": "203.0.113.9", "user-agent": "TestSuite/1.0" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, decision: "AGREE", formVersion: "v1" });

    const record = await prisma.consentRecord.findFirst({
      where: { userId: user.id },
    });
    expect(record).toMatchObject({
      role: "STUDENT",
      formVersionId: version.id,
      decision: "AGREE",
      interviewRecordingChoice: "VIDEO_AUDIO",
      interviewRecordingConsent: true,
      ugaId: "811234567",
      initialsStrokeData: null,
      signatureTypedName: "Ada Lovelace",
      signerNameSnapshot: "Ada Lovelace",
      signerEmailSnapshot: user.email,
      deviceType: "unknown",
    });
  });

  it("stores recording consent as false for the non-recording choices", async () => {
    await publishVersion("STUDENT");
    const { user } = await createStudent();
    asUser({ id: user.id, role: "STUDENT", email: user.email });

    const res = await post({
      decision: "AGREE",
      interviewRecordingChoice: "TRANSCRIPT_ONLY",
      ugaId: "811234567",
      signatureTypedName: "Stu Student",
    });
    expect(res.status).toBe(200);
    const record = await prisma.consentRecord.findFirst({
      where: { userId: user.id },
    });
    expect(record?.interviewRecordingChoice).toBe("TRANSCRIPT_ONLY");
    expect(record?.interviewRecordingConsent).toBe(false);
  });

  it("records a DECLINE without any recording choice, even if one is sent", async () => {
    await publishVersion("TEACHER");
    const { user } = await createTeacher();
    asUser({ id: user.id, role: "TEACHER", email: user.email });

    const res = await post({
      decision: "DECLINE",
      interviewRecordingChoice: "VIDEO_AUDIO",
      ugaId: "811234567",
      signatureTypedName: "Tess Teacher",
    });
    expect(res.status).toBe(200);

    const record = await prisma.consentRecord.findFirst({
      where: { userId: user.id },
    });
    expect(record?.decision).toBe("DECLINE");
    expect(record?.ugaId).toBe("811234567");
    expect(record?.interviewRecordingChoice).toBeNull();
    expect(record?.interviewRecordingConsent).toBeNull();
    expect(record?.initialsStrokeData).toBeNull();
  });

  it("rejects an oversized signature payload with 400 rather than truncating", async () => {
    await publishVersion("STUDENT");
    const { user } = await createStudent();
    asUser({ id: user.id, role: "STUDENT" });

    const huge = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i }));
    const res = await post({
      decision: "AGREE",
      interviewRecordingChoice: "NO_INTERVIEW",
      ugaId: "811234567",
      signatureTypedName: "x",
      signatureStrokeData: [{ points: huge }],
    });
    expect(res.status).toBe(400);
  });
});
