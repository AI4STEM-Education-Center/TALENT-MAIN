import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  recordGuardrailEvent,
  submitGuardrailFeedback,
  readReasons,
  isGuardrailFeedbackStatus,
  MAX_FEEDBACK_CHARS,
} from "@/lib/guardrail-events";
import { resetDb, createStudent } from "./db";

beforeEach(async () => {
  await resetDb();
});

describe("recordGuardrailEvent", () => {
  it("stores the surface, subject, user and reasons", async () => {
    const id = await recordGuardrailEvent({
      surface: "assistant_chat",
      subjectId: "conv-1",
      userId: "u1",
      blocked: true,
      reasons: ["jailbreak (0.92)"],
    });

    expect(id).toBeTruthy();
    const row = await prisma.guardrailEvent.findUniqueOrThrow({
      where: { id: id! },
    });
    expect(row.surface).toBe("assistant_chat");
    expect(row.subjectId).toBe("conv-1");
    expect(row.userId).toBe("u1");
    expect(row.blocked).toBe(true);
    expect(readReasons(row.reasons)).toEqual(["jailbreak (0.92)"]);
  });

  it("records a non-blocking warning too", async () => {
    const id = await recordGuardrailEvent({
      surface: "quiz_extraction",
      blocked: false,
      reasons: ["off-topic (0.80)"],
    });
    const row = await prisma.guardrailEvent.findUniqueOrThrow({
      where: { id: id! },
    });
    expect(row.blocked).toBe(false);
    expect(row.userId).toBeNull();
  });
});

describe("readReasons", () => {
  it("survives anything that is not a string array", () => {
    expect(readReasons("not json")).toEqual([]);
    expect(readReasons('{"a":1}')).toEqual([]);
    expect(readReasons('["ok", 5, null]')).toEqual(["ok"]);
  });
});

describe("isGuardrailFeedbackStatus", () => {
  it("accepts the three statuses and nothing else", () => {
    expect(isGuardrailFeedbackStatus("NEW")).toBe(true);
    expect(isGuardrailFeedbackStatus("REVIEWED")).toBe(true);
    expect(isGuardrailFeedbackStatus("DISMISSED")).toBe(true);
    expect(isGuardrailFeedbackStatus("new")).toBe(false);
    expect(isGuardrailFeedbackStatus(null)).toBe(false);
  });
});

describe("submitGuardrailFeedback", () => {
  async function eventFor(userId: string | null) {
    const id = await recordGuardrailEvent({
      surface: "assistant_chat",
      userId,
      blocked: true,
      reasons: ["jailbreak (0.92)"],
    });
    return id!;
  }

  it("attaches a report to the reporter's own event", async () => {
    const { user } = await createStudent();
    const eventId = await eventFor(user.id);

    expect(
      await submitGuardrailFeedback(
        eventId,
        user.id,
        "  I asked about momentum.  ",
      ),
    ).toBe("saved");

    const row = await prisma.guardrailFeedback.findUniqueOrThrow({
      where: { eventId },
    });
    expect(row.message).toBe("I asked about momentum.");
    expect(row.status).toBe("NEW");
    expect(row.userId).toBe(user.id);
  });

  it("refuses an empty message rather than storing a blank report", async () => {
    const { user } = await createStudent();
    const eventId = await eventFor(user.id);

    expect(await submitGuardrailFeedback(eventId, user.id, "   \n ")).toBe(
      "empty",
    );
    expect(await prisma.guardrailFeedback.count()).toBe(0);
  });

  it("caps a very long report", async () => {
    const { user } = await createStudent();
    const eventId = await eventFor(user.id);

    await submitGuardrailFeedback(
      eventId,
      user.id,
      "x".repeat(MAX_FEEDBACK_CHARS + 500),
    );
    const row = await prisma.guardrailFeedback.findUniqueOrThrow({
      where: { eventId },
    });
    expect(row.message).toHaveLength(MAX_FEEDBACK_CHARS);
  });

  it("reads another user's event as not_found, not forbidden", async () => {
    // Reporting "forbidden" would confirm the id exists, which turns this into
    // a way to probe how often other people trip the guardrails.
    const { user: owner } = await createStudent();
    const { user: other } = await createStudent();
    const eventId = await eventFor(owner.id);

    expect(await submitGuardrailFeedback(eventId, other.id, "let me in")).toBe(
      "not_found",
    );
    expect(await prisma.guardrailFeedback.count()).toBe(0);
  });

  it("reads an unknown id as not_found", async () => {
    const { user } = await createStudent();
    expect(await submitGuardrailFeedback("nope", user.id, "hello")).toBe(
      "not_found",
    );
  });

  it("cannot be claimed on an event recorded with no user", async () => {
    const { user } = await createStudent();
    const eventId = await eventFor(null);
    expect(await submitGuardrailFeedback(eventId, user.id, "mine now")).toBe(
      "not_found",
    );
  });

  it("EDITS an existing report rather than stacking a second one", async () => {
    const { user } = await createStudent();
    const eventId = await eventFor(user.id);

    await submitGuardrailFeedback(eventId, user.id, "first try");
    await submitGuardrailFeedback(
      eventId,
      user.id,
      "actually, here is more detail",
    );

    expect(await prisma.guardrailFeedback.count()).toBe(1);
    const row = await prisma.guardrailFeedback.findUniqueOrThrow({
      where: { eventId },
    });
    expect(row.message).toBe("actually, here is more detail");
  });

  it("reopens a report that had already been reviewed", async () => {
    const { user } = await createStudent();
    const eventId = await eventFor(user.id);
    await submitGuardrailFeedback(eventId, user.id, "first try");
    await prisma.guardrailFeedback.update({
      where: { eventId },
      data: {
        status: "REVIEWED",
        reviewedAt: new Date(),
        reviewedBy: "admin-1",
      },
    });

    await submitGuardrailFeedback(eventId, user.id, "it happened again");

    const row = await prisma.guardrailFeedback.findUniqueOrThrow({
      where: { eventId },
    });
    expect(row.status).toBe("NEW");
    expect(row.reviewedAt).toBeNull();
    expect(row.reviewedBy).toBeNull();
  });

  it("is removed with its event", async () => {
    const { user } = await createStudent();
    const eventId = await eventFor(user.id);
    await submitGuardrailFeedback(eventId, user.id, "hello");

    await prisma.guardrailEvent.delete({ where: { id: eventId } });
    expect(await prisma.guardrailFeedback.count()).toBe(0);
  });
});
