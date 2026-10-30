import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as ELIGIBILITY, POST } from "@/app/api/recordings/route";
import {
  GET as GET_RECORDING,
  DELETE as DELETE_RECORDING,
} from "@/app/api/admin/session-recordings/[id]/route";
import { GET as GET_CHUNK } from "@/app/api/admin/session-recordings/[id]/chunks/[seq]/route";
import { areaWhere, parseAreas } from "@/lib/session-recording-server";
import { auth } from "@/lib/auth";
import * as consentHelpers from "@/lib/consent";
import { prisma } from "@/lib/prisma";
import { purgeExpiredSessionRecordings } from "@/lib/session-recording-retention";
import {
  RECORDING_MAX_BYTES,
  RECORDING_MAX_BYTES_PER_STUDENT,
  RECORDING_MAX_CHUNK_RAW_BYTES,
  RECORDING_RETENTION_DAYS,
} from "@/lib/session-recording";
import { createAdmin, createStudent, createTeacher, resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const REC = "11111111-2222-4333-8444-555555555555";
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

const snapshot = [
  { type: 4, timestamp: T0, data: { href: "https://x.test/student" } },
  { type: 2, timestamp: T0 + 1, data: { node: {} } },
];
const increments = [
  { type: 3, timestamp: T0 + 2_000, data: { source: 2, type: 2, id: 1 } },
];

function upload(overrides: Record<string, unknown> = {}, events = snapshot) {
  return new Request("http://localhost/api/recordings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      recordingId: REC,
      seq: 0,
      startedAt: T0,
      entryPath: "/student",
      viewport: { width: 1280, height: 720 },
      encoding: "gzip",
      data: gzipSync(JSON.stringify(events)).toString("base64"),
      ...overrides,
    }),
  }) as never;
}

const asUser = (id: string, role: string) =>
  mockAuth.mockResolvedValue({ user: { id, role } } as never);

async function consent(userId: string, decision = "AGREE") {
  const form =
    (await prisma.consentFormVersion.findFirst({
      where: { role: "STUDENT", isActive: true },
    })) ??
    (await prisma.consentFormVersion.create({
      data: {
        role: "STUDENT",
        version: "v1",
        title: "Student form",
        bodyHtml: "<p>hi</p>",
        isActive: true,
      },
    }));
  await prisma.consentRecord.create({
    data: {
      userId,
      role: "STUDENT",
      formVersionId: form.id,
      decision,
      signedAt: new Date(T0 - 1000),
      signatureTypedName: "Stu Student",
      ipAddress: "127.0.0.1",
      userAgent: "test",
      deviceType: "desktop",
      signerNameSnapshot: "Stu Student",
      signerEmailSnapshot: `${userId}@example.com`,
    },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const chunkParams = (id: string, seq: string) => ({
  params: Promise.resolve({ id, seq }),
});

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await resetDb();
});

describe("POST /api/recordings", () => {
  it("rejects anyone who is not signed in or not a student", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await POST(upload())).status).toBe(401);

    const { user } = await createTeacher();
    asUser(user.id, "TEACHER");
    expect((await POST(upload())).status).toBe(403);
    expect(await prisma.sessionRecording.count()).toBe(0);
  });

  it("discards uploads and says stop without research consent", async () => {
    const { user } = await createStudent();
    asUser(user.id, "STUDENT");

    for (const decision of [null, "DECLINE"] as const) {
      if (decision) await consent(user.id, decision);
      const res = await POST(upload());
      expect(await res.json()).toEqual({
        ok: true,
        accepted: false,
        stop: "no_consent",
      });
    }
    expect(await prisma.sessionRecording.count()).toBe(0);
  });

  it("creates a recording on the first batch and appends later ones", async () => {
    const { user, student } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");

    expect(await (await POST(upload())).json()).toEqual({
      ok: true,
      accepted: true,
    });
    expect(
      (await POST(upload({ seq: 1, final: true }, increments as never))).status,
    ).toBe(200);

    const row = await prisma.sessionRecording.findUniqueOrThrow({
      where: { id: REC },
    });
    expect(row).toMatchObject({
      studentId: student.id,
      entryPath: "/student",
      chunkCount: 2,
      eventCount: 3,
      viewportWidth: 1280,
    });
    expect(row.byteCount).toBeGreaterThan(0);
    expect(row.endedAt?.getTime()).toBe(T0 + 2_000);
    expect(row.lastEventAt.getTime()).toBe(T0 + 2_000);
  });

  it("acknowledges a retried batch without storing it twice", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");

    await POST(upload());
    const retry = await POST(upload());
    expect(await retry.json()).toEqual({
      ok: true,
      accepted: true,
      duplicate: true,
    });
    const row = await prisma.sessionRecording.findUniqueOrThrow({
      where: { id: REC },
    });
    expect(row.chunkCount).toBe(1);
    expect(row.eventCount).toBe(2);
  });

  it("does not let a student write into someone else's recording", async () => {
    const owner = await createStudent();
    const other = await createStudent();
    await consent(owner.user.id);
    await consent(other.user.id);
    asUser(owner.user.id, "STUDENT");
    await POST(upload());

    asUser(other.user.id, "STUDENT");
    expect((await POST(upload({ seq: 1 }, increments as never))).status).toBe(
      404,
    );
    expect(
      (await prisma.sessionRecording.findUniqueOrThrow({ where: { id: REC } }))
        .chunkCount,
    ).toBe(1);
  });

  it("starts a recording only from a batch with the opening snapshot", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");

    const res = await POST(upload({ seq: 3 }, increments as never));
    expect(await res.json()).toMatchObject({
      accepted: false,
      stop: "restart",
    });
    expect(await prisma.sessionRecording.count()).toBe(0);
  });

  it("tells the client to rotate once a recording is full", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    await POST(upload());
    await prisma.sessionRecording.update({
      where: { id: REC },
      data: { byteCount: RECORDING_MAX_BYTES },
    });

    const res = await POST(upload({ seq: 1 }, increments as never));
    expect(await res.json()).toMatchObject({
      accepted: false,
      stop: "recording_full",
    });
  });

  it("checks eligibility before capture and excludes research-exempt students with old consent", async () => {
    const { user, student } = await createStudent();
    asUser(user.id, "STUDENT");
    expect(await (await ELIGIBILITY()).json()).toEqual({ allowed: false });
    await consent(user.id);
    expect(await (await ELIGIBILITY()).json()).toEqual({ allowed: true });
    const { teacher } = await createTeacher();
    const cls = await prisma.class.create({
      data: { name: "Excluded", teacherId: teacher.id, researchExcluded: true },
    });
    await prisma.classEnrollment.create({
      data: { classId: cls.id, studentId: student.id },
    });
    expect(await (await ELIGIBILITY()).json()).toEqual({ allowed: false });
    expect(await (await POST(upload())).json()).toMatchObject({
      stop: "no_consent",
    });
    expect(await prisma.sessionRecording.count()).toBe(0);
  });

  it("rejects withdrawal mid-session, superseded forms and events captured before agreement", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    await POST(upload());
    await prisma.consentRecord.updateMany({ data: { decision: "DECLINE" } });
    expect(
      await (await POST(upload({ seq: 1 }, increments as never))).json(),
    ).toMatchObject({ stop: "no_consent" });
    await prisma.consentRecord.updateMany({
      data: { decision: "AGREE", signedAt: new Date(T0 + 5000) },
    });
    expect(
      await (await POST(upload({ seq: 1 }, increments as never))).json(),
    ).toMatchObject({ stop: "no_consent" });
    await prisma.consentFormVersion.updateMany({ data: { isActive: false } });
    expect(
      await (await POST(upload({ seq: 1 }, increments as never))).json(),
    ).toMatchObject({ stop: "no_consent" });
    expect(await prisma.sessionRecordingChunk.count()).toBe(1);
  });

  it("serializes concurrent first uploads and acknowledges only an actual duplicate", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    const results = await Promise.all([POST(upload()), POST(upload())]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies).toContainEqual({ ok: true, accepted: true });
    expect(bodies).toContainEqual({
      ok: true,
      accepted: true,
      duplicate: true,
    });
    expect(await prisma.sessionRecordingChunk.count()).toBe(1);
    const other = await createStudent();
    await consent(other.user.id);
    await prisma.sessionRecording.deleteMany();
    mockAuth
      .mockResolvedValueOnce({
        user: { id: user.id, role: "STUDENT" },
      } as never)
      .mockResolvedValueOnce({
        user: { id: other.user.id, role: "STUDENT" },
      } as never);
    const collision = await Promise.all([POST(upload()), POST(upload())]);
    expect(collision.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await prisma.sessionRecordingChunk.count()).toBe(1);
  });

  it("checks duplicates before caps and enforces quotas across concurrent appends", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    await POST(upload());
    const size = gzipSync(JSON.stringify(increments)).length;
    await prisma.sessionRecording.update({
      where: { id: REC },
      data: { byteCount: RECORDING_MAX_BYTES - size },
    });
    const results = await Promise.all([
      POST(upload({ seq: 1 }, increments as never)),
      POST(upload({ seq: 2 }, increments as never)),
    ]);
    expect(await Promise.all(results.map((r) => r.json()))).toContainEqual({
      ok: true,
      accepted: false,
      stop: "recording_full",
    });
    expect(
      (await prisma.sessionRecording.findUniqueOrThrow({ where: { id: REC } }))
        .byteCount,
    ).toBe(RECORDING_MAX_BYTES);
    expect(await (await POST(upload())).json()).toMatchObject({
      duplicate: true,
    });
    await prisma.sessionRecording.update({
      where: { id: REC },
      data: { byteCount: RECORDING_MAX_BYTES_PER_STUDENT },
    });
    expect(
      await (
        await POST(
          upload({ recordingId: "aaaaaaaa-2222-4333-8444-555555555555" }),
        )
      ).json(),
    ).toMatchObject({ stop: "quota" });
    expect(await (await POST(upload())).json()).toMatchObject({
      duplicate: true,
    });
  });

  it("rechecks consent after an intervening withdrawal before the write transaction", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    const spy = vi
      .spyOn(consentHelpers, "hasResearchConsent")
      .mockImplementationOnce(async () => {
        await prisma.consentRecord.updateMany({
          data: { decision: "DECLINE" },
        });
        return true;
      });
    try {
      expect(await (await POST(upload())).json()).toMatchObject({
        stop: "no_consent",
      });
      expect(await prisma.sessionRecording.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("serializes per-student quota across distinct recordings and preserves area unions", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    await POST(upload());
    await Promise.all([
      POST(
        upload({ seq: 1, path: "/student/simulations" }, increments as never),
      ),
      POST(upload({ seq: 2, path: "/student/materials" }, increments as never)),
    ]);
    expect(
      (await prisma.sessionRecording.findUniqueOrThrow({ where: { id: REC } }))
        .areas,
    ).toBe(",simulation,material,");
    const size = gzipSync(JSON.stringify(snapshot)).length;
    await prisma.sessionRecording.update({
      where: { id: REC },
      data: { byteCount: RECORDING_MAX_BYTES_PER_STUDENT - size },
    });
    const results = await Promise.all([
      POST(upload({ recordingId: "aaaaaaaa-2222-4333-8444-555555555555" })),
      POST(upload({ recordingId: "bbbbbbbb-2222-4333-8444-555555555555" })),
    ]);
    expect(await Promise.all(results.map((r) => r.json()))).toContainEqual({
      ok: true,
      accepted: false,
      stop: "quota",
    });
    expect(
      (await prisma.sessionRecording.aggregate({ _sum: { byteCount: true } }))
        ._sum.byteCount,
    ).toBe(RECORDING_MAX_BYTES_PER_STUDENT);
  });

  it("keeps end timestamps monotonic when final and earlier batches arrive out of order", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    await POST(upload());
    await POST(upload({ seq: 2, final: true }, increments as never));
    await POST(upload({ seq: 1, final: true }));
    const row = await prisma.sessionRecording.findUniqueOrThrow({
      where: { id: REC },
    });
    expect(row.endedAt).toEqual(row.lastEventAt);
  });

  it("rejects zip bombs and invalid dates and clamps untrusted future retention timestamps", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    const bomb = gzipSync(
      " ".repeat(RECORDING_MAX_CHUNK_RAW_BYTES + 1),
    ).toString("base64");
    expect((await POST(upload({ data: bomb }))).status).toBe(400);
    expect(
      (await POST(upload({ startedAt: Number.MAX_SAFE_INTEGER }))).status,
    ).toBe(400);
    const before = Date.now();
    await POST(
      upload({}, [
        { type: 2, timestamp: Date.UTC(2099, 0, 1), data: {} },
      ] as never),
    );
    const row = await prisma.sessionRecording.findUniqueOrThrow({
      where: { id: REC },
    });
    expect(row.lastEventAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.lastEventAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("rejects malformed payloads", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");

    expect((await POST(upload({ data: "not-gzip" }))).status).toBe(400);
    expect((await POST(upload({ recordingId: "nope" }))).status).toBe(400);
    expect(
      (await POST(upload({}, [{ type: 99, timestamp: T0 }] as never))).status,
    ).toBe(400);
    const plain = await POST(
      upload({ encoding: "json", data: JSON.stringify(snapshot) }),
    );
    expect(plain.status).toBe(200);
  });
});

describe("admin session recording routes", () => {
  async function seedRecording() {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    await POST(upload());
    await POST(upload({ seq: 1 }, increments as never));
  }

  it("lets admins and researchers read, but not teachers or students", async () => {
    await seedRecording();

    const admin = await createAdmin();
    asUser(admin.id, "ADMIN");
    const meta = await (await GET_RECORDING({} as never, params(REC))).json();
    expect(meta).toMatchObject({
      id: REC,
      studentName: "Stu Student",
      chunks: [{ seq: 0 }, { seq: 1 }],
    });
    const chunk = await (
      await GET_CHUNK({} as never, chunkParams(REC, "1"))
    ).json();
    expect(chunk.events).toEqual(increments);

    asUser("r1", "RESEARCHER");
    expect((await GET_RECORDING({} as never, params(REC))).status).toBe(200);

    for (const role of ["TEACHER", "STUDENT"]) {
      asUser("x", role);
      expect((await GET_RECORDING({} as never, params(REC))).status).toBe(403);
      expect((await GET_CHUNK({} as never, chunkParams(REC, "0"))).status).toBe(
        403,
      );
    }
    asUser(admin.id, "ADMIN");
    expect((await GET_CHUNK({} as never, chunkParams(REC, "9"))).status).toBe(
      404,
    );
    expect((await GET_CHUNK({} as never, chunkParams(REC, "x"))).status).toBe(
      404,
    );
  });

  it("limits deletion to admins and removes the chunks with it", async () => {
    await seedRecording();

    asUser("r1", "RESEARCHER");
    expect((await DELETE_RECORDING({} as never, params(REC))).status).toBe(403);

    const admin = await createAdmin();
    asUser(admin.id, "ADMIN");
    expect((await DELETE_RECORDING({} as never, params(REC))).status).toBe(200);
    expect(await prisma.sessionRecording.count()).toBe(0);
    expect(await prisma.sessionRecordingChunk.count()).toBe(0);
    expect((await DELETE_RECORDING({} as never, params(REC))).status).toBe(404);
  });
});

describe("retention and account deletion", () => {
  it("purges recordings past the retention window", async () => {
    const { user, student } = await createStudent();
    await consent(user.id);
    const day = 24 * 60 * 60 * 1000;
    const mk = (id: string, ageDays: number) =>
      prisma.sessionRecording.create({
        data: {
          id,
          studentId: student.id,
          startedAt: new Date(Date.now() - ageDays * day),
          lastEventAt: new Date(Date.now() - ageDays * day),
          entryPath: "/student",
          userAgent: "t",
          deviceType: "desktop",
          viewportWidth: 1,
          viewportHeight: 1,
        },
      });
    await mk("old", RECORDING_RETENTION_DAYS + 1);
    await mk("fresh", 1);

    expect(await purgeExpiredSessionRecordings()).toBe(1);
    expect(
      (await prisma.sessionRecording.findMany()).map((row) => row.id),
    ).toEqual(["fresh"]);
  });

  it("deletes a student's recordings with the student", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    await POST(upload());

    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.sessionRecording.count()).toBe(0);
    expect(await prisma.sessionRecordingChunk.count()).toBe(0);
  });
});

describe("recording areas", () => {
  it("seeds, unions, filters, and preserves idempotency across batches", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    const first = [{ type: 2, timestamp: T0, data: {} }];
    expect(
      (
        await POST(
          upload({ entryPath: "/student/classes/c/quiz/q" }, first as never),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await POST(
          upload({ seq: 1, path: "/student/simulations" }, increments as never),
        )
      ).status,
    ).toBe(200);
    const areaEvents = [
      {
        type: 5,
        timestamp: T0 + 3000,
        data: { tag: "area", payload: { area: "material", state: "enter" } },
      },
    ];
    expect((await POST(upload({ seq: 2 }, areaEvents as never))).status).toBe(
      200,
    );
    const retry = await POST(
      upload({ seq: 2, path: "/student" }, increments as never),
    );
    expect(await retry.json()).toMatchObject({ duplicate: true });
    const row = await prisma.sessionRecording.findUniqueOrThrow({
      where: { id: REC },
    });
    expect(row.areas).toBe(",quiz,simulation,material,");
    expect(row.chunkCount).toBe(3);
    const legacy = await prisma.sessionRecording.create({
      data: {
        id: "legacy",
        studentId: row.studentId,
        startedAt: new Date(T0),
        lastEventAt: new Date(T0),
        entryPath: "/student",
        userAgent: "test",
        deviceType: "desktop",
        viewportWidth: 100,
        viewportHeight: 100,
      },
    });
    expect(legacy.areas).toBe("");

    for (const area of ["quiz", "simulation", "material"]) {
      expect(
        await prisma.sessionRecording.count({ where: areaWhere(area) }),
      ).toBe(1);
    }
    asUser("r1", "RESEARCHER");
    expect(
      await (await GET_RECORDING({} as never, params(REC))).json(),
    ).toMatchObject({ areas: ["quiz", "simulation", "material"] });
  });

  it("keeps unknown later batch context unknown and handles old rows and exact tokens", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    await POST(upload());
    const duplicate = await POST(upload({ path: "/student/simulations" }));
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    await POST(
      upload({ seq: 1, entryPath: "/student/materials" }, increments as never),
    );
    expect(
      (await prisma.sessionRecording.findUniqueOrThrow({ where: { id: REC } }))
        .areas,
    ).toBe("");
    expect(
      await prisma.sessionRecording.count({ where: areaWhere("quiz") }),
    ).toBe(0);
    expect(parseAreas("")).toEqual([]);
    expect(areaWhere("bogus")).toEqual({});
    expect(areaWhere(undefined)).toEqual({});
    await prisma.sessionRecording.update({
      where: { id: REC },
      data: { areas: ",quizzer," },
    });
    expect(
      await prisma.sessionRecording.count({ where: areaWhere("quiz") }),
    ).toBe(0);
    asUser("r1", "RESEARCHER");
    expect(
      await (await GET_RECORDING({} as never, params(REC))).json(),
    ).toMatchObject({ areas: [] });
  });

  it("accepts the optional starting path only up to 300 characters", async () => {
    const { user } = await createStudent();
    await consent(user.id);
    asUser(user.id, "STUDENT");
    expect((await POST(upload({ path: "x".repeat(301) }))).status).toBe(400);
    expect((await POST(upload({ path: 1 }))).status).toBe(400);
  });
});
