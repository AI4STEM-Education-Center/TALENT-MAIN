import { describe, it, expect, vi, beforeEach } from "vitest";

// resolveInviteCode only touches the database through these two helpers; stub
// them so the resolution order can be tested without SQLite.
vi.mock("@/lib/teacher-registration-codes", () => ({
  findTeacherCode: vi.fn(),
  hasRedeemableTeacherCode: vi.fn(),
}));

import {
  resolveInviteCode,
  submittedInviteCode,
  tokenMatches,
} from "@/lib/registration";
import {
  findTeacherCode,
  hasRedeemableTeacherCode,
} from "@/lib/teacher-registration-codes";

const mockFind = vi.mocked(findTeacherCode);
const mockHas = vi.mocked(hasRedeemableTeacherCode);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "code-1",
    code: "ABCDEFGHJKMNPQRS",
    label: null,
    role: "TEACHER",
    expiresAt: null,
    maxUses: null,
    usedCount: 0,
    active: true,
    createdAt: new Date(),
    createdById: null,
    lastUsedAt: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockHas.mockResolvedValue(true);
  mockFind.mockResolvedValue(null);
});

describe("submittedInviteCode", () => {
  it("prefers inviteCode, then the legacy keys", () => {
    expect(submittedInviteCode({ inviteCode: "a", teacherToken: "b" })).toBe(
      "a",
    );
    expect(submittedInviteCode({ teacherToken: "b" })).toBe("b");
    expect(submittedInviteCode({ adminToken: "c" })).toBe("c");
    expect(submittedInviteCode({ inviteCode: "", adminToken: "c" })).toBe("c");
  });

  it("ignores non-string values and non-object bodies", () => {
    expect(submittedInviteCode({ inviteCode: 42 })).toBe("");
    expect(submittedInviteCode(null)).toBe("");
    expect(submittedInviteCode("code")).toBe("");
  });
});

describe("tokenMatches", () => {
  it("matches only identical strings", () => {
    expect(tokenMatches("secret", "secret")).toBe(true);
    expect(tokenMatches("Secret", "secret")).toBe(false);
    expect(tokenMatches("secre", "secret")).toBe(false);
  });

  it("never matches when either side is empty", () => {
    expect(tokenMatches("", "")).toBe(false);
    expect(tokenMatches("", undefined)).toBe(false);
    expect(tokenMatches("x", undefined)).toBe(false);
    expect(tokenMatches("x", "")).toBe(false);
  });
});

describe("resolveInviteCode", () => {
  const env = { ADMIN_SIGNUP_TOKEN: "adm", TEACHER_SIGNUP_TOKEN: "tch" };

  it("maps the admin env token to ADMIN without touching the database", async () => {
    const r = await resolveInviteCode("adm", env);
    expect(r).toMatchObject({ ok: true, role: "ADMIN", source: "ADMIN_ENV" });
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockHas).not.toHaveBeenCalled();
  });

  it("maps the teacher env token to TEACHER", async () => {
    const r = await resolveInviteCode("tch", env);
    expect(r).toMatchObject({
      ok: true,
      role: "TEACHER",
      source: "TEACHER_ENV",
    });
  });

  it("never matches an empty submission against an empty env var", async () => {
    mockHas.mockResolvedValue(false);
    const r = await resolveInviteCode("", {
      ADMIN_SIGNUP_TOKEN: "",
      TEACHER_SIGNUP_TOKEN: "",
    });
    expect(r).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
  });

  it("is NOT_CONFIGURED only when no env token and no redeemable code exist", async () => {
    mockHas.mockResolvedValue(false);
    expect(await resolveInviteCode("x", {})).toEqual({
      ok: false,
      reason: "NOT_CONFIGURED",
    });
    expect(
      await resolveInviteCode("x", { ADMIN_SIGNUP_TOKEN: "adm" }),
    ).toMatchObject({ ok: false, reason: "INVALID" });
  });

  it.each(["TEACHER", "RESEARCHER"])(
    "maps an active %s code to its role",
    async (role) => {
      mockFind.mockResolvedValue(row({ role }));
      const r = await resolveInviteCode("abcd-efgh", {});
      expect(r).toMatchObject({ ok: true, role, source: "CODE" });
    },
  );

  it("rejects a code whose stored role is ADMIN", async () => {
    mockFind.mockResolvedValue(row({ role: "ADMIN" }));
    expect(await resolveInviteCode("x", {})).toMatchObject({
      ok: false,
      reason: "INVALID",
      status: "BAD_ROLE",
    });
  });

  it("rejects revoked, expired and exhausted codes with their status", async () => {
    mockFind.mockResolvedValue(row({ active: false }));
    expect(await resolveInviteCode("x", {})).toMatchObject({
      status: "REVOKED",
    });
    mockFind.mockResolvedValue(row({ expiresAt: new Date(0) }));
    expect(await resolveInviteCode("x", {})).toMatchObject({
      status: "EXPIRED",
    });
    mockFind.mockResolvedValue(row({ maxUses: 1, usedCount: 1 }));
    expect(await resolveInviteCode("x", {})).toMatchObject({
      status: "EXHAUSTED",
    });
  });

  it("reports an unknown code as UNKNOWN", async () => {
    expect(await resolveInviteCode("nope", {})).toMatchObject({
      ok: false,
      reason: "INVALID",
      code: null,
      status: "UNKNOWN",
    });
  });
});
