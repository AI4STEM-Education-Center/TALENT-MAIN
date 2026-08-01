import { describe, it, expect, afterEach, vi } from "vitest";
// These are the module's pure helpers — stub the database module so the suite
// never needs a live SQLite connection to check them.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import {
  backoffSecondsFor,
  buildMessageEmail,
  classifyDeliveryError,
  describeDeliveryError,
  resolveAppUrl,
  selectEmailRecipients,
  summarizeDeliveries,
  MESSAGE_EMAIL_MAX_ATTEMPTS,
} from "./message-email";
import { SmtpNotConfiguredError } from "./email";

describe("backoffSecondsFor", () => {
  it("escalates 1m → 5m → 15m → 1h across attempts", () => {
    expect(backoffSecondsFor(1)).toBe(60);
    expect(backoffSecondsFor(2)).toBe(300);
    expect(backoffSecondsFor(3)).toBe(900);
    expect(backoffSecondsFor(4)).toBe(3600);
  });

  it("holds at the longest delay past the end of the schedule", () => {
    expect(backoffSecondsFor(MESSAGE_EMAIL_MAX_ATTEMPTS)).toBe(3600);
    expect(backoffSecondsFor(99)).toBe(3600);
  });

  it("treats a zero/negative attempt as the first one", () => {
    expect(backoffSecondsFor(0)).toBe(60);
    expect(backoffSecondsFor(-3)).toBe(60);
  });
});

describe("classifyDeliveryError", () => {
  it("gives up on a 5xx SMTP refusal — the mailbox will not appear on retry", () => {
    const rejected = Object.assign(new Error("550 5.1.1 no such user"), { responseCode: 550 });
    expect(classifyDeliveryError(rejected)).toBe("PERMANENT");
  });

  it("retries a 4xx greylist/throttle", () => {
    const busy = Object.assign(new Error("451 try again later"), { responseCode: 451 });
    expect(classifyDeliveryError(busy)).toBe("TRANSIENT");
  });

  it("retries connection failures and anything unrecognized", () => {
    expect(classifyDeliveryError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })))
      .toBe("TRANSIENT");
    expect(classifyDeliveryError(new Error("boom"))).toBe("TRANSIENT");
    expect(classifyDeliveryError("weird")).toBe("TRANSIENT");
  });

  it("retries an unconfigured SMTP server so an admin can still fix it", () => {
    expect(classifyDeliveryError(new SmtpNotConfiguredError("nope"))).toBe("TRANSIENT");
  });
});

describe("describeDeliveryError", () => {
  it("flattens whitespace and truncates for storage", () => {
    expect(describeDeliveryError(new Error("line one\n  line two"))).toBe("line one line two");
    expect(describeDeliveryError(new Error("x".repeat(500)))).toHaveLength(300);
  });

  it("falls back to a readable string for non-errors", () => {
    expect(describeDeliveryError("plain")).toBe("plain");
    expect(describeDeliveryError(new Error(""))).toBe("Unknown error");
  });
});

describe("selectEmailRecipients", () => {
  it("keeps one entry per address, lower-cased, mapped to its user", () => {
    const recipients = selectEmailRecipients([
      { userId: "u1", email: "A@Example.com" },
      { userId: "u2", email: " b@example.com " },
    ]);
    expect([...recipients.entries()]).toEqual([
      ["a@example.com", "u1"],
      ["b@example.com", "u2"],
    ]);
  });

  it("drops missing and malformed addresses", () => {
    const recipients = selectEmailRecipients([
      { userId: "u1", email: null },
      { userId: "u2", email: "" },
      { userId: "u3", email: "not-an-email" },
      { userId: "u4", email: "ok@example.com" },
    ]);
    expect([...recipients.keys()]).toEqual(["ok@example.com"]);
  });

  it("keeps the first user when two accounts share an address", () => {
    // MessageEmailDelivery is unique per (message, email), so a duplicate would
    // otherwise break the insert — and email the same person twice.
    const recipients = selectEmailRecipients([
      { userId: "first", email: "shared@example.com" },
      { userId: "second", email: "SHARED@example.com" },
    ]);
    expect(recipients.size).toBe(1);
    expect(recipients.get("shared@example.com")).toBe("first");
  });

  it("records a null user when the address has no account behind it", () => {
    expect(selectEmailRecipients([{ email: "roster@example.com" }]).get("roster@example.com")).toBeNull();
  });
});

describe("summarizeDeliveries", () => {
  it("stays QUEUED while anything is still pending", () => {
    expect(summarizeDeliveries({ pending: 1, sent: 4, failed: 1 })).toEqual({
      status: "QUEUED",
      sentCount: 4,
    });
  });

  it("settles on SENT, PARTIAL, or FAILED once nothing is pending", () => {
    expect(summarizeDeliveries({ pending: 0, sent: 5, failed: 0 })).toEqual({ status: "SENT", sentCount: 5 });
    expect(summarizeDeliveries({ pending: 0, sent: 3, failed: 2 })).toEqual({ status: "PARTIAL", sentCount: 3 });
    expect(summarizeDeliveries({ pending: 0, sent: 0, failed: 2 })).toEqual({ status: "FAILED", sentCount: 0 });
  });

  it("reports SENT for a message that queued no email at all", () => {
    expect(summarizeDeliveries({ pending: 0, sent: 0, failed: 0 })).toEqual({ status: "SENT", sentCount: 0 });
  });
});

describe("buildMessageEmail", () => {
  const base = {
    subject: "Quiz 3 moved",
    body: "It is now due Friday.",
    senderName: "Tess Teacher",
    className: "Physics 101",
  };

  it("prefixes the subject with the class so students can triage", () => {
    expect(buildMessageEmail(base).subject).toBe("[Physics 101] Quiz 3 moved");
  });

  it("leaves the subject alone when the message has no class", () => {
    expect(buildMessageEmail({ ...base, className: null }).subject).toBe("Quiz 3 moved");
  });

  it("includes the message body and signs off with the sender", () => {
    const { text } = buildMessageEmail(base);
    expect(text).toContain("Tess Teacher sent you a new message in Physics 101:");
    expect(text).toContain("It is now due Friday.");
    expect(text).toContain("— Tess Teacher (Physics 101)");
  });

  it("links to the mailbox when an app URL is configured", () => {
    const { text } = buildMessageEmail({ ...base, appUrl: "https://app.example.com" });
    expect(text).toContain("https://app.example.com/student/notifications");
  });

  it("degrades to plain guidance when no app URL is configured", () => {
    const { text } = buildMessageEmail({ ...base, appUrl: null });
    expect(text).not.toContain("http");
    expect(text).toContain("Sign in to see all your messages under Notifications.");
  });
});

describe("resolveAppUrl", () => {
  const original = process.env.APP_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = original;
  });

  it("trims trailing slashes so links never double up", () => {
    process.env.APP_URL = "https://app.example.com/";
    expect(resolveAppUrl()).toBe("https://app.example.com");
  });

  it("returns null when unset or blank", () => {
    delete process.env.APP_URL;
    expect(resolveAppUrl()).toBeNull();
    process.env.APP_URL = "   ";
    expect(resolveAppUrl()).toBeNull();
  });
});
