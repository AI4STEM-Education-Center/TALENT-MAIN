import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, PUT } from "@/app/api/admin/email-senders/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSenderIdentity, type ResolvedSmtpConfig } from "@/lib/email";
import { resetDb } from "./db";

const mockAuth = vi.mocked(auth);

function asAdmin() {
  mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } } as never);
}
function asTeacher() {
  mockAuth.mockResolvedValue({ user: { id: "t-1", role: "TEACHER" } } as never);
}

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/admin/email-senders", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function seedSmtp(overrides: Partial<{ fromEmail: string; senderDomain: string | null }> = {}) {
  return prisma.smtpConfig.create({
    data: {
      id: "singleton",
      host: "smtp.example.com",
      port: 465,
      secure: true,
      fromEmail: overrides.fromEmail ?? "fallback@example.com",
      fromName: "AI4Talent",
      senderDomain: overrides.senderDomain ?? null,
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

describe("GET /api/admin/email-senders", () => {
  it("403s a non-admin", async () => {
    asTeacher();
    expect((await GET()).status).toBe(403);
  });

  it("returns a row per purpose seeded from the catalog defaults", async () => {
    await seedSmtp();
    asAdmin();

    const body = await (await GET()).json();
    const byPurpose = Object.fromEntries(
      body.senders.map((s: { purpose: string; localPart: string }) => [s.purpose, s.localPart])
    );
    expect(byPurpose.PASSWORD_RESET).toBe("password-reset");
    expect(byPurpose.NOTIFICATION).toBe("notification");
    expect(byPurpose.CONTACT_TEACHER).toBe("no-contact");
    expect(body.smtpConfigured).toBe(true);
  });

  it("resolves to the single From address until a domain is set", async () => {
    await seedSmtp();
    asAdmin();

    const body = await (await GET()).json();
    for (const sender of body.senders) {
      expect(sender.resolved.fromEmail).toBe("fallback@example.com");
    }
  });
});

describe("PUT /api/admin/email-senders", () => {
  it("403s a non-admin", async () => {
    asTeacher();
    expect((await put({ senderDomain: "example.com", senders: [] })).status).toBe(403);
  });

  it("saves a shared domain and hands each purpose its own address", async () => {
    await seedSmtp();
    asAdmin();

    const res = await put({
      senderDomain: "@edwarcheng.net",
      senders: [
        { purpose: "PASSWORD_RESET", localPart: "password-reset" },
        { purpose: "NOTIFICATION", localPart: "notification" },
      ],
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.senderDomain).toBe("edwarcheng.net");
    const resolved = Object.fromEntries(
      body.senders.map((s: { purpose: string; resolved: { fromEmail: string } }) => [
        s.purpose,
        s.resolved.fromEmail,
      ])
    );
    expect(resolved.PASSWORD_RESET).toBe("password-reset@edwarcheng.net");
    expect(resolved.NOTIFICATION).toBe("notification@edwarcheng.net");
  });

  it("is what the mailer actually reads back", async () => {
    await seedSmtp();
    asAdmin();
    await put({
      senderDomain: "edwarcheng.net",
      senders: [
        {
          purpose: "PASSWORD_RESET",
          localPart: "reset",
          fromName: "Talent Security",
          replyTo: "help@edwarcheng.net",
        },
      ],
    });

    const cfg: ResolvedSmtpConfig = {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      username: null,
      password: null,
      fromEmail: "fallback@example.com",
      fromName: "AI4Talent",
      senderDomain: "edwarcheng.net",
      isActive: true,
    };
    expect(await getSenderIdentity("PASSWORD_RESET", cfg)).toEqual({
      fromEmail: "reset@edwarcheng.net",
      fromName: "Talent Security",
      replyTo: "help@edwarcheng.net",
    });
  });

  it("rejects a malformed domain without writing anything", async () => {
    await seedSmtp();
    asAdmin();

    const res = await put({
      senderDomain: "not a domain",
      senders: [{ purpose: "PASSWORD_RESET", localPart: "reset" }],
    });
    expect(res.status).toBe(400);
    expect(await prisma.emailSender.count()).toBe(0);
  });

  it("rejects a malformed address prefix without writing anything", async () => {
    await seedSmtp();
    asAdmin();

    const res = await put({
      senderDomain: "edwarcheng.net",
      senders: [
        { purpose: "PASSWORD_RESET", localPart: "password reset" },
        { purpose: "NOTIFICATION", localPart: "notification" },
      ],
    });
    expect(res.status).toBe(400);
    expect(await prisma.emailSender.count()).toBe(0);
  });

  it("rejects an unknown purpose", async () => {
    await seedSmtp();
    asAdmin();
    const res = await put({ senderDomain: "", senders: [{ purpose: "NOT_A_PURPOSE", localPart: "x" }] });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed reply-to", async () => {
    await seedSmtp();
    asAdmin();
    const res = await put({
      senderDomain: "",
      senders: [{ purpose: "PASSWORD_RESET", localPart: "reset", replyTo: "nope" }],
    });
    expect(res.status).toBe(400);
  });

  it("explains that the SMTP server must be saved before a domain can be", async () => {
    asAdmin();
    const res = await put({ senderDomain: "edwarcheng.net", senders: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/SMTP server settings/i);
  });

  it("falls back to the catalog default when the prefix is left blank", async () => {
    await seedSmtp();
    asAdmin();
    await put({ senderDomain: "edwarcheng.net", senders: [{ purpose: "NOTIFICATION", localPart: "" }] });

    const row = await prisma.emailSender.findUnique({ where: { purpose: "NOTIFICATION" } });
    expect(row?.localPart).toBe("notification");
  });

  it("drops subject/body for purposes whose copy a user writes", async () => {
    await seedSmtp();
    asAdmin();
    await put({
      senderDomain: "edwarcheng.net",
      senders: [
        { purpose: "NOTIFICATION", localPart: "notification", subject: "nope", body: "nope" },
        { purpose: "PASSWORD_RESET", localPart: "password-reset", subject: "Reset it", body: "Link: {{resetUrl}}" },
      ],
    });

    const notification = await prisma.emailSender.findUnique({ where: { purpose: "NOTIFICATION" } });
    expect(notification?.subject).toBeNull();
    expect(notification?.body).toBeNull();

    const reset = await prisma.emailSender.findUnique({ where: { purpose: "PASSWORD_RESET" } });
    expect(reset?.subject).toBe("Reset it");
    expect(reset?.body).toBe("Link: {{resetUrl}}");
  });

  it("clears the shared domain when the field is emptied", async () => {
    await seedSmtp({ senderDomain: "edwarcheng.net" });
    asAdmin();

    const body = await (await put({ senderDomain: "", senders: [] })).json();
    expect(body.senderDomain).toBeNull();
    expect(body.senders[0].resolved.fromEmail).toBe("fallback@example.com");
  });
});
