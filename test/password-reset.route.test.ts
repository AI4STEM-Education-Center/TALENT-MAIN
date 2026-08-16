import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Keep SmtpNotConfiguredError real (routes branch on `instanceof`) and stub
// only the send calls.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendPurposeEmail: vi.fn() };
});

import bcrypt from "bcryptjs";
import { POST as FORGOT } from "@/app/api/auth/forgot-password/route";
import { GET as CHECK_TOKEN, POST as RESET } from "@/app/api/auth/reset-password/route";
import { prisma } from "@/lib/prisma";
import { sendPurposeEmail, SmtpNotConfiguredError } from "@/lib/email";
import { hashResetToken, MAX_RESET_REQUESTS_PER_USER } from "@/lib/password-reset";
import { resetDb, createStudent } from "./db";

const mockSend = vi.mocked(sendPurposeEmail);

function postForgot(body: unknown) {
  return FORGOT(
    new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000" },
      body: JSON.stringify(body),
    }) as never
  );
}

function postReset(body: unknown) {
  return RESET(
    new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000" },
      body: JSON.stringify(body),
    }) as never
  );
}

function checkToken(token: string) {
  const url = `http://localhost/api/auth/reset-password?token=${encodeURIComponent(token)}`;
  // The route reads req.nextUrl.searchParams; a plain Request has no nextUrl.
  return CHECK_TOKEN({ nextUrl: new URL(url), headers: new Headers(), url } as never);
}

/** Pull the raw token out of the reset URL handed to the (mocked) mailer. */
function tokenFromLastEmail(): string {
  const [, , vars] = mockSend.mock.calls.at(-1)!;
  return new URL(vars.resetUrl as string).searchParams.get("token")!;
}

/** Drive a full "forgot password" request and return the emailed token. */
async function requestReset(identifier: string): Promise<string> {
  const res = await postForgot({ identifier });
  expect(res.status).toBe(200);
  return tokenFromLastEmail();
}

beforeEach(async () => {
  await resetDb();
  mockSend.mockReset();
  mockSend.mockResolvedValue({ sent: 1, failed: 0, errors: [] });
  delete process.env.APP_BASE_URL;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/auth/forgot-password", () => {
  it("emails a single-use link for a known email address", async () => {
    const { user } = await createStudent({ email: "ada@example.com", username: "ada" });

    const res = await postForgot({ identifier: "Ada@Example.com" });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    expect(mockSend).toHaveBeenCalledOnce();
    const [purpose, to] = mockSend.mock.calls[0];
    expect(purpose).toBe("PASSWORD_RESET");
    expect(to).toBe("ada@example.com");

    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    // Only the hash is persisted — the raw token lives in the email.
    expect(tokens[0].tokenHash).toBe(hashResetToken(tokenFromLastEmail()));
    expect(tokens[0].tokenHash).not.toContain(tokenFromLastEmail());
  });

  it("also accepts a username", async () => {
    await createStudent({ email: "ada@example.com", username: "ada" });
    await postForgot({ identifier: "ADA" });
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("gives the same answer for an unknown account and sends nothing", async () => {
    await createStudent({ email: "ada@example.com", username: "ada" });

    const known = await postForgot({ identifier: "ada@example.com" });
    mockSend.mockClear();
    const unknown = await postForgot({ identifier: "nobody@example.com" });

    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
    expect(mockSend).not.toHaveBeenCalled();
    expect(await prisma.passwordResetToken.count()).toBe(1);
  });

  it("voids the previous link when a new one is requested", async () => {
    const { user } = await createStudent();
    const first = await requestReset(user.email);
    await requestReset(user.email);

    const firstRecord = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(first) },
    });
    expect(firstRecord?.usedAt).not.toBeNull();

    const stillValid = await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } });
    expect(stillValid).toBe(1);
  });

  it("stops mail-bombing one account once its request budget is spent", async () => {
    const { user } = await createStudent();
    for (let i = 0; i < MAX_RESET_REQUESTS_PER_USER; i++) {
      await postForgot({ identifier: user.email });
    }
    mockSend.mockClear();

    const res = await postForgot({ identifier: user.email });
    expect(res.status).toBe(200); // still the generic reply
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("says so plainly when the server has no email configured", async () => {
    await createStudent({ email: "ada@example.com", username: "ada" });
    mockSend.mockRejectedValueOnce(new SmtpNotConfiguredError("No SMTP server is configured."));

    const res = await postForgot({ identifier: "ada@example.com" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/administrator/i);
  });

  it("builds the link from APP_BASE_URL when one is set", async () => {
    process.env.APP_BASE_URL = "https://dev.ai4talent.org";
    const { user } = await createStudent();
    const token = await requestReset(user.email);

    const [, , vars] = mockSend.mock.calls[0];
    expect(vars.resetUrl).toBe(
      `https://dev.ai4talent.org/reset-password?token=${encodeURIComponent(token)}`
    );
  });

  it("rejects an empty identifier with 400", async () => {
    expect((await postForgot({ identifier: "   " })).status).toBe(400);
  });
});

describe("GET /api/auth/reset-password", () => {
  it("reports a freshly issued link as valid", async () => {
    const { user } = await createStudent({ username: "ada" });
    const token = await requestReset(user.email);

    const body = await (await checkToken(token)).json();
    expect(body).toMatchObject({ valid: true, username: "ada" });
  });

  it("reports an unknown token as invalid", async () => {
    const body = await (await checkToken("made-up")).json();
    expect(body.valid).toBe(false);
  });

  it("reports an expired link as invalid", async () => {
    const { user } = await createStudent();
    const token = await requestReset(user.email);
    await prisma.passwordResetToken.update({
      where: { tokenHash: hashResetToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await (await checkToken(token)).json()).valid).toBe(false);
  });
});

describe("POST /api/auth/reset-password", () => {
  const NEW_PASSWORD = "Brand2New!";

  it("sets the new password and burns the link", async () => {
    const { user } = await createStudent();
    const token = await requestReset(user.email);

    const res = await postReset({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare(NEW_PASSWORD, stored!.hashedPassword)).toBe(true);

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
    });
    expect(record?.usedAt).not.toBeNull();
  });

  it("emails the password-changed notice after a successful reset", async () => {
    const { user } = await createStudent();
    const token = await requestReset(user.email);
    mockSend.mockClear();

    await postReset({ token, password: NEW_PASSWORD });

    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toBe("PASSWORD_CHANGED");
  });

  it("refuses to redeem the same link twice", async () => {
    const { user } = await createStudent();
    const token = await requestReset(user.email);

    expect((await postReset({ token, password: NEW_PASSWORD })).status).toBe(200);

    const second = await postReset({ token, password: "Another3#" });
    expect(second.status).toBe(400);

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare(NEW_PASSWORD, stored!.hashedPassword)).toBe(true);
  });

  it("rejects an unknown token with 400", async () => {
    const res = await postReset({ token: "not-a-real-token", password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects an expired token with 400", async () => {
    const { user } = await createStudent();
    const token = await requestReset(user.email);
    await prisma.passwordResetToken.update({
      where: { tokenHash: hashResetToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await postReset({ token, password: NEW_PASSWORD })).status).toBe(400);

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare("Password1!", stored!.hashedPassword)).toBe(true);
  });

  it("keeps the link usable when the chosen password is too weak", async () => {
    const { user } = await createStudent();
    const token = await requestReset(user.email);

    expect((await postReset({ token, password: "weak" })).status).toBe(400);

    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
    });
    expect(record?.usedAt).toBeNull();
    expect((await postReset({ token, password: NEW_PASSWORD })).status).toBe(200);
  });

  it("voids the account's other outstanding links", async () => {
    const { user } = await createStudent();
    // A stale grant issued out-of-band (the route itself only keeps one live).
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: "sibling-hash", expiresAt: new Date(Date.now() + 60_000) },
    });
    const token = await requestReset(user.email);

    await postReset({ token, password: NEW_PASSWORD });

    const sibling = await prisma.passwordResetToken.findUnique({ where: { tokenHash: "sibling-hash" } });
    expect(sibling?.usedAt).not.toBeNull();
  });
});
