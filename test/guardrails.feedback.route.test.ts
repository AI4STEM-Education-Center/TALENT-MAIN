import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { POST } from "@/app/api/guardrails/feedback/route";
import {
  GET as adminGet,
  PATCH as adminPatch,
} from "@/app/api/admin/guardrails/feedback/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  recordGuardrailEvent,
  submitGuardrailFeedback,
} from "@/lib/guardrail-events";
import { resetDb, createStudent, createAdmin } from "./db";

const mockAuth = vi.mocked(auth);
const asUser = (id: string, role = "STUDENT") =>
  mockAuth.mockResolvedValue({ user: { id, role } } as never);

function postReq(body: unknown) {
  return new Request("http://localhost/api/guardrails/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function adminGetReq(query = "") {
  return new Request(`http://localhost/api/admin/guardrails/feedback${query}`);
}

function patchReq(body: unknown) {
  return new Request("http://localhost/api/admin/guardrails/feedback", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function eventFor(
  userId: string | null,
  overrides: { blocked?: boolean } = {},
) {
  const id = await recordGuardrailEvent({
    surface: "assistant_chat",
    subjectId: "conv-1",
    userId,
    blocked: overrides.blocked ?? true,
    reasons: ["jailbreak (0.92)"],
  });
  return id!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});

describe("POST /api/guardrails/feedback", () => {
  it("lets a STUDENT report a block on their own turn", async () => {
    // Students hit guardrails too, and one who cannot report a false positive
    // is one who quietly stops using the assistant.
    const { user } = await createStudent();
    const eventId = await eventFor(user.id);
    asUser(user.id);

    const res = await POST(
      postReq({ eventId, message: "I asked about momentum." }),
    );
    expect(res.status).toBe(200);

    const row = await prisma.guardrailFeedback.findUniqueOrThrow({
      where: { eventId },
    });
    expect(row.message).toBe("I asked about momentum.");
  });

  it("requires a signed-in user", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await POST(postReq({ eventId: "e", message: "hi" }))).status).toBe(
      401,
    );
  });

  it("rejects a missing eventId or message", async () => {
    const { user } = await createStudent();
    asUser(user.id);
    expect((await POST(postReq({ message: "hi" }))).status).toBe(400);
    expect((await POST(postReq({ eventId: "e" }))).status).toBe(400);
  });

  it("rejects a blank message", async () => {
    const { user } = await createStudent();
    const eventId = await eventFor(user.id);
    asUser(user.id);
    expect((await POST(postReq({ eventId, message: "   " }))).status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const { user } = await createStudent();
    asUser(user.id);
    expect((await POST(postReq("not json"))).status).toBe(400);
  });

  it("404s on someone else's event and stores nothing", async () => {
    const { user: owner } = await createStudent();
    const { user: other } = await createStudent();
    const eventId = await eventFor(owner.id);
    asUser(other.id);

    expect(
      (await POST(postReq({ eventId, message: "let me in" }))).status,
    ).toBe(404);
    expect(await prisma.guardrailFeedback.count()).toBe(0);
  });
});

describe("GET /api/admin/guardrails/feedback", () => {
  async function seed() {
    const { user } = await createStudent();
    const admin = await createAdmin();
    const eventId = await eventFor(user.id);
    await submitGuardrailFeedback(
      eventId,
      user.id,
      "This was my homework question.",
    );
    return { user, admin, eventId };
  }

  it("returns the report next to the reasons the user was never shown", async () => {
    const { user, admin } = await seed();
    asUser(admin.id, "ADMIN");

    const res = await adminGet(adminGetReq());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0].message).toBe("This was my homework question.");
    expect(body.feedback[0].reasons).toEqual(["jailbreak (0.92)"]);
    expect(body.feedback[0].blocked).toBe(true);
    expect(body.feedback[0].surfaceLabel).toBeTruthy();
    expect(body.feedback[0].user.email).toBe(user.email);
  });

  it("filters by status", async () => {
    const { admin } = await seed();
    asUser(admin.id, "ADMIN");

    expect(
      (await (await adminGet(adminGetReq("?status=NEW"))).json()).feedback,
    ).toHaveLength(1);
    expect(
      (await (await adminGet(adminGetReq("?status=DISMISSED"))).json())
        .feedback,
    ).toHaveLength(0);
  });

  it("ignores an unknown status rather than returning nothing", async () => {
    const { admin } = await seed();
    asUser(admin.id, "ADMIN");
    expect(
      (await (await adminGet(adminGetReq("?status=BOGUS"))).json()).feedback,
    ).toHaveLength(1);
  });

  it("still returns a report whose author was deleted", async () => {
    const { user, admin } = await seed();
    asUser(admin.id, "ADMIN");
    await prisma.user.delete({ where: { id: user.id } });

    const body = await (await adminGet(adminGetReq())).json();
    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0].user).toBeNull();
  });

  it("is admin-only", async () => {
    const { user } = await seed();
    asUser(user.id, "STUDENT");
    expect((await adminGet(adminGetReq())).status).toBe(403);
  });
});

describe("PATCH /api/admin/guardrails/feedback", () => {
  async function seed() {
    const { user } = await createStudent();
    const admin = await createAdmin();
    const eventId = await eventFor(user.id);
    await submitGuardrailFeedback(
      eventId,
      user.id,
      "This was my homework question.",
    );
    const row = await prisma.guardrailFeedback.findUniqueOrThrow({
      where: { eventId },
    });
    return { user, admin, row };
  }

  it("marks a report reviewed and stamps who did it", async () => {
    const { admin, row } = await seed();
    asUser(admin.id, "ADMIN");

    expect(
      (await adminPatch(patchReq({ id: row.id, status: "REVIEWED" }))).status,
    ).toBe(200);

    const after = await prisma.guardrailFeedback.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("REVIEWED");
    expect(after.reviewedBy).toBe(admin.id);
    expect(after.reviewedAt).not.toBeNull();
  });

  it("clears the review stamp when a report is reopened", async () => {
    const { admin, row } = await seed();
    asUser(admin.id, "ADMIN");
    await adminPatch(patchReq({ id: row.id, status: "REVIEWED" }));

    await adminPatch(patchReq({ id: row.id, status: "NEW" }));

    const after = await prisma.guardrailFeedback.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.reviewedAt).toBeNull();
    expect(after.reviewedBy).toBeNull();
  });

  it("rejects an unknown status", async () => {
    const { admin, row } = await seed();
    asUser(admin.id, "ADMIN");
    expect(
      (await adminPatch(patchReq({ id: row.id, status: "MAYBE" }))).status,
    ).toBe(400);
  });

  it("404s on an unknown id", async () => {
    const { admin } = await seed();
    asUser(admin.id, "ADMIN");
    expect(
      (await adminPatch(patchReq({ id: "nope", status: "REVIEWED" }))).status,
    ).toBe(404);
  });

  it("is admin-only", async () => {
    const { user, row } = await seed();
    asUser(user.id, "STUDENT");

    expect(
      (await adminPatch(patchReq({ id: row.id, status: "DISMISSED" }))).status,
    ).toBe(403);
    const after = await prisma.guardrailFeedback.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("NEW");
  });
});
