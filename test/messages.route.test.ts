import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueMessageEmails: vi.fn() }));
// Keep the real SmtpNotConfiguredError (the engine classifies on it); stub only
// the transport call.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmailToRecipient: vi.fn() };
});

import { GET, POST } from "@/app/api/classes/[id]/messages/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueMessageEmails } from "@/lib/queue";
import { sendEmailToRecipient } from "@/lib/email";
import {
  deliverMessageEmail,
  failExhaustedMessageEmails,
  findStrandedMessageEmails,
  MESSAGE_EMAIL_MAX_ATTEMPTS,
} from "@/lib/message-email";
import { resetDb, createTeacher, createStudent, createClass } from "./db";

const mockAuth = vi.mocked(auth);
const mockEnqueue = vi.mocked(enqueueMessageEmails);
const mockSend = vi.mocked(sendEmailToRecipient);

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function jsonReq(body: unknown) {
  return new Request("http://localhost/api/classes/c1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function getReq() {
  return new Request("http://localhost/api/classes/c1/messages") as never;
}

/** A class owned by a fresh teacher with `count` enrolled students. */
async function seedClass(count: number, opts: { emails?: (string | null)[] } = {}) {
  const { user: teacherUser, teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  const students = [];
  for (let i = 0; i < count; i += 1) {
    const email = opts.emails?.[i];
    const { user, student } = await createStudent(
      email ? { email } : undefined
    );
    await prisma.classEnrollment.create({ data: { classId: cls.id, studentId: student.id } });
    students.push({ user, student });
  }
  mockAuth.mockResolvedValue({ user: { id: teacherUser.id, role: "TEACHER" } } as never);
  return { teacherUser, teacher, cls, students };
}

const ORIGINAL_APP_URL = process.env.APP_URL;

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockEnqueue.mockReset();
  mockSend.mockReset();
  // Deployments configure this; pin it so the emailed link is deterministic.
  process.env.APP_URL = "https://app.test";
});

afterAll(async () => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
  await prisma.$disconnect();
});

describe("POST /api/classes/[id]/messages", () => {
  it("rejects a caller who is not a teacher", async () => {
    const { user } = await createStudent();
    mockAuth.mockResolvedValue({ user: { id: user.id, role: "STUDENT" } } as never);
    const res = await POST(jsonReq({ subject: "hi", body: "there" }), params("nope"));
    expect(res.status).toBe(401);
  });

  it("rejects a class the teacher does not own", async () => {
    const other = await createTeacher();
    const foreignClass = await createClass(other.teacher.id);
    const { user: teacherUser } = await createTeacher();
    mockAuth.mockResolvedValue({ user: { id: teacherUser.id, role: "TEACHER" } } as never);

    const res = await POST(jsonReq({ subject: "hi", body: "there" }), params(foreignClass.id));
    expect(res.status).toBe(404);
  });

  it("requires a subject and a body", async () => {
    const { cls } = await seedClass(1);
    expect((await POST(jsonReq({ subject: " ", body: "x" }), params(cls.id))).status).toBe(400);
    expect((await POST(jsonReq({ subject: "x", body: "" }), params(cls.id))).status).toBe(400);
  });

  it("refuses a class nobody has joined — there is no audience to notify", async () => {
    const { cls } = await seedClass(0);
    const res = await POST(jsonReq({ subject: "hi", body: "there" }), params(cls.id));
    expect(res.status).toBe(400);
    expect(await prisma.message.count()).toBe(0);
  });

  it("notifies every enrolled student in-app and queues one email per address on file", async () => {
    const { cls } = await seedClass(2, { emails: ["a@example.com", "b@example.com"] });

    const res = await POST(
      jsonReq({ subject: "Quiz moved", body: "Now due Friday." }),
      params(cls.id)
    );
    expect(res.status).toBe(201);
    const payload = await res.json();

    expect(payload.inApp.count).toBe(2);
    expect(payload.email).toMatchObject({ recipients: 2, queued: 2, skippedReason: null });

    const message = await prisma.message.findFirstOrThrow();
    expect(message.channels).toBe("IN_APP,EMAIL");
    // Queued, not sent: nothing may claim delivery before the worker runs.
    expect(message.status).toBe("QUEUED");
    expect(message.sentCount).toBe(0);
    expect(message.recipientCount).toBe(2);
    expect(message.inAppCount).toBe(2);

    expect(await prisma.notification.count({ where: { messageId: message.id } })).toBe(2);

    const deliveries = await prisma.messageEmailDelivery.findMany({ orderBy: { email: "asc" } });
    expect(deliveries.map((d) => d.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(deliveries.every((d) => d.status === "PENDING" && d.attempts === 0)).toBe(true);

    // One job per recipient, so a single bad address can't hold up the class.
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect([...mockEnqueue.mock.calls[0][0]].sort()).toEqual(deliveries.map((d) => d.id).sort());
  });

  it("still delivers in-app when a student has no usable address", async () => {
    const { cls, students } = await seedClass(2, { emails: ["good@example.com", "b@example.com"] });
    await prisma.user.update({ where: { id: students[1].user.id }, data: { email: "not-an-email" } });

    const res = await POST(jsonReq({ subject: "s", body: "b" }), params(cls.id));
    const payload = await res.json();

    expect(payload.inApp.count).toBe(2);
    expect(payload.email.queued).toBe(1);
    expect((await prisma.messageEmailDelivery.findMany()).map((d) => d.email)).toEqual([
      "good@example.com",
    ]);
  });

  it("queues nothing (but still notifies) when the send would blow the email budget", async () => {
    const { cls, teacher } = await seedClass(2, { emails: ["a@example.com", "b@example.com"] });
    await prisma.teacher.update({ where: { id: teacher.id }, data: { emailDailyLimit: 1 } });

    const res = await POST(jsonReq({ subject: "s", body: "b" }), params(cls.id));
    expect(res.status).toBe(201);
    const payload = await res.json();

    expect(payload.inApp.count).toBe(2);
    expect(payload.email.queued).toBe(0);
    expect(payload.email.skippedReason).toMatch(/budget/i);

    const message = await prisma.message.findFirstOrThrow();
    expect(message.channels).toBe("IN_APP");
    expect(message.status).toBe("SENT");
    // Nothing was attempted, so nothing is charged against the quota.
    expect(message.recipientCount).toBe(0);
    expect(await prisma.messageEmailDelivery.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(2);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("keeps the delivery rows when enqueueing throws, so the sweeper can recover them", async () => {
    const { cls } = await seedClass(1, { emails: ["a@example.com"] });
    mockEnqueue.mockImplementation(() => {
      throw new Error("queue database is locked");
    });

    const res = await POST(jsonReq({ subject: "s", body: "b" }), params(cls.id));
    expect(res.status).toBe(201);
    expect((await res.json()).email.queued).toBe(0);

    const delivery = await prisma.messageEmailDelivery.findFirstOrThrow();
    expect(delivery.status).toBe("PENDING");
  });
});

describe("GET /api/classes/[id]/messages", () => {
  it("returns the audience a message would reach and each message's delivery tally", async () => {
    const { cls } = await seedClass(2, { emails: ["a@example.com", "b@example.com"] });
    await POST(jsonReq({ subject: "s", body: "b" }), params(cls.id));

    const [first] = await prisma.messageEmailDelivery.findMany({ orderBy: { email: "asc" } });
    await prisma.messageEmailDelivery.update({
      where: { id: first.id },
      data: { status: "SENT", sentAt: new Date() },
    });

    const payload = await (await GET(getReq(), params(cls.id))).json();
    expect(payload.audience).toEqual({ enrolled: 2, emailable: 2 });
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].email).toEqual({ queued: 1, sent: 1, failed: 0 });
  });
});

describe("deliverMessageEmail", () => {
  /** A queued single-recipient message, ready for the worker to pick up. */
  async function seedQueuedMessage() {
    const { cls } = await seedClass(1, { emails: ["student@example.com"] });
    await POST(jsonReq({ subject: "Quiz moved", body: "Now due Friday." }), params(cls.id));
    const delivery = await prisma.messageEmailDelivery.findFirstOrThrow();
    return { delivery, messageId: delivery.messageId };
  }

  it("sends the email, marks the row SENT, and settles the message status", async () => {
    const { delivery, messageId } = await seedQueuedMessage();

    const outcome = await deliverMessageEmail(delivery.id);
    expect(outcome).toEqual({ status: "SENT" });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0][0];
    expect(sent).toMatchObject({ to: "student@example.com" });
    expect(sent.subject).toContain("Quiz moved");
    // The email announces the message and links to it; the message itself
    // stays on the platform.
    expect(sent.text).toContain(`?message=${delivery.messageId}`);
    expect(sent.text).not.toContain("Now due Friday.");

    const row = await prisma.messageEmailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("SENT");
    expect(row.attempts).toBe(1);
    expect(row.claimedAt).toBeNull();
    expect(row.sentAt).not.toBeNull();

    const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(message.status).toBe("SENT");
    expect(message.sentCount).toBe(1);
    expect(message.error).toBeNull();
  });

  it("does not email the same recipient twice", async () => {
    const { delivery } = await seedQueuedMessage();
    await deliverMessageEmail(delivery.id);

    const second = await deliverMessageEmail(delivery.id);
    expect(second.status).toBe("SKIPPED");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("leaves a row held by another worker alone until its lease expires", async () => {
    const { delivery } = await seedQueuedMessage();
    await prisma.messageEmailDelivery.update({
      where: { id: delivery.id },
      data: { claimedAt: new Date() },
    });

    expect((await deliverMessageEmail(delivery.id)).status).toBe("SKIPPED");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("reclaims a row whose worker died mid-send", async () => {
    const { delivery } = await seedQueuedMessage();
    await prisma.messageEmailDelivery.update({
      where: { id: delivery.id },
      data: { claimedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    expect((await deliverMessageEmail(delivery.id)).status).toBe("SENT");
  });

  it("retries a transient failure with backoff and keeps the message queued", async () => {
    const { delivery, messageId } = await seedQueuedMessage();
    mockSend.mockRejectedValueOnce(Object.assign(new Error("451 busy"), { responseCode: 451 }));

    const outcome = await deliverMessageEmail(delivery.id);
    expect(outcome).toMatchObject({ status: "RETRY", delaySeconds: 60 });

    const row = await prisma.messageEmailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.claimedAt).toBeNull();
    expect(row.lastError).toContain("451");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    expect((await prisma.message.findUniqueOrThrow({ where: { id: messageId } })).status).toBe("QUEUED");
  });

  it("gives up immediately on a rejected address and reports why", async () => {
    const { delivery, messageId } = await seedQueuedMessage();
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error("550 5.1.1 no such user"), { responseCode: 550 })
    );

    const outcome = await deliverMessageEmail(delivery.id);
    expect(outcome).toMatchObject({ status: "FAILED" });

    const row = await prisma.messageEmailDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(1);

    const message = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(message.status).toBe("FAILED");
    expect(message.error).toContain("student@example.com");
  });

  it("stops retrying once the attempt budget is spent", async () => {
    const { delivery } = await seedQueuedMessage();
    await prisma.messageEmailDelivery.update({
      where: { id: delivery.id },
      data: { attempts: MESSAGE_EMAIL_MAX_ATTEMPTS - 1 },
    });
    mockSend.mockRejectedValueOnce(new Error("socket hang up"));

    expect((await deliverMessageEmail(delivery.id)).status).toBe("FAILED");
    expect(
      (await prisma.messageEmailDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status
    ).toBe("FAILED");
  });

  it("reports PARTIAL when some recipients land and others do not", async () => {
    const { cls } = await seedClass(2, { emails: ["a@example.com", "b@example.com"] });
    await POST(jsonReq({ subject: "s", body: "b" }), params(cls.id));
    const [a, b] = await prisma.messageEmailDelivery.findMany({ orderBy: { email: "asc" } });

    await deliverMessageEmail(a.id);
    mockSend.mockRejectedValueOnce(Object.assign(new Error("550 nope"), { responseCode: 550 }));
    await deliverMessageEmail(b.id);

    const message = await prisma.message.findUniqueOrThrow({ where: { id: a.messageId } });
    expect(message.status).toBe("PARTIAL");
    expect(message.sentCount).toBe(1);
  });

  it("skips a delivery whose message was deleted underneath it", async () => {
    const { delivery, messageId } = await seedQueuedMessage();
    await prisma.message.delete({ where: { id: messageId } });

    expect((await deliverMessageEmail(delivery.id)).status).toBe("SKIPPED");
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("sweeper", () => {
  async function seedDelivery(data: Partial<{ attempts: number; nextAttemptAt: Date; claimedAt: Date }>) {
    const { cls } = await seedClass(1, { emails: ["student@example.com"] });
    await POST(jsonReq({ subject: "s", body: "b" }), params(cls.id));
    const delivery = await prisma.messageEmailDelivery.findFirstOrThrow();
    return prisma.messageEmailDelivery.update({ where: { id: delivery.id }, data });
  }

  it("finds a due row whose job never ran", async () => {
    const stranded = await seedDelivery({ nextAttemptAt: new Date(Date.now() - 30 * 60 * 1000) });
    expect(await findStrandedMessageEmails()).toEqual([stranded.id]);
  });

  it("leaves a freshly queued row to its own job", async () => {
    await seedDelivery({ nextAttemptAt: new Date() });
    expect(await findStrandedMessageEmails()).toEqual([]);
  });

  it("leaves a row a live worker is holding", async () => {
    await seedDelivery({
      nextAttemptAt: new Date(Date.now() - 30 * 60 * 1000),
      claimedAt: new Date(),
    });
    expect(await findStrandedMessageEmails()).toEqual([]);
  });

  it("ignores rows that already used every attempt", async () => {
    await seedDelivery({
      nextAttemptAt: new Date(Date.now() - 30 * 60 * 1000),
      attempts: MESSAGE_EMAIL_MAX_ATTEMPTS,
    });
    expect(await findStrandedMessageEmails()).toEqual([]);
  });

  it("closes out a row that ran out of attempts without a verdict", async () => {
    const stuck = await seedDelivery({ attempts: MESSAGE_EMAIL_MAX_ATTEMPTS });

    expect(await failExhaustedMessageEmails()).toBe(1);

    const row = await prisma.messageEmailDelivery.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toMatch(/Gave up/);
    // The teacher's history stops saying "queued" once nothing is coming.
    expect((await prisma.message.findUniqueOrThrow({ where: { id: row.messageId } })).status).toBe(
      "FAILED"
    );
  });
});
