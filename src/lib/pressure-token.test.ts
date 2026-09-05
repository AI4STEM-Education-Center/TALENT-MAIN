import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// vi.mock is hoisted above module scope, so the spies have to be too.
const {
  findUnique,
  update,
  updateMany,
  sysCreate,
  userFindMany,
  smtpFindFirst,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  sysCreate: vi.fn(),
  userFindMany: vi.fn(),
  smtpFindFirst: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    pressureResultToken: { findUnique, update, updateMany },
    systemLog: { create: sysCreate },
    user: { findMany: userFindMany },
    smtpConfig: { findFirst: smtpFindFirst },
  },
}));

import {
  bearerToken,
  generatePressureToken,
  hashPressureToken,
  pressureTokenPrefix,
  REVOKED_TOKEN_ALERT_THROTTLE_MS,
  verifyPressureToken,
} from "./pressure-token";

beforeEach(() => {
  vi.useRealTimers();
  findUnique.mockReset();
  update.mockReset().mockResolvedValue({ revokedUseCount: 1 });
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  sysCreate.mockReset().mockResolvedValue({});
  userFindMany.mockReset().mockResolvedValue([]);
  smtpFindFirst.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("generatePressureToken", () => {
  it("mints a prefixed, high-entropy, unique token", () => {
    const first = generatePressureToken();
    const second = generatePressureToken();
    expect(first).toMatch(/^ptr_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });
});

describe("hashPressureToken", () => {
  it("is deterministic and never returns the plaintext", () => {
    const token = generatePressureToken();
    const digest = hashPressureToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(hashPressureToken(token));
    expect(digest).not.toContain(token.slice(4));
  });
});

describe("pressureTokenPrefix", () => {
  it("keeps only a short, non-secret slice for display", () => {
    const token = generatePressureToken();
    const prefix = pressureTokenPrefix(token);
    expect(prefix).toHaveLength(10);
    expect(token.startsWith(prefix)).toBe(true);
  });
});

describe("bearerToken", () => {
  it("accepts a bearer header regardless of scheme casing", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
  });

  it("rejects a missing, empty, or non-bearer header", () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});

describe("verifyPressureToken", () => {
  it("looks the token up by digest and records the use", async () => {
    const token = generatePressureToken();
    findUnique.mockResolvedValue({
      id: "tok_1",
      name: "ci",
      tokenPrefix: "ptr_abc",
      revokedAt: null,
      revokedUseCount: 0,
      lastRevokedUseAt: null,
      lastRevokedAlertAt: null,
    });

    await expect(verifyPressureToken(`Bearer ${token}`)).resolves.toEqual({
      id: "tok_1",
      name: "ci",
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashPressureToken(token) },
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tok_1" } }),
    );
  });

  it("rejects a revoked token but counts the use for leak detection", async () => {
    const now = new Date("2026-09-03T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    findUnique.mockResolvedValue({
      id: "tok_1",
      name: "ci",
      tokenPrefix: "ptr_abc",
      revokedAt: new Date(),
      revokedUseCount: 0,
      lastRevokedUseAt: null,
      lastRevokedAlertAt: null,
    });
    await expect(
      verifyPressureToken(`Bearer ${generatePressureToken()}`, {
        ip: "1.2.3.4",
      }),
    ).resolves.toBeNull();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tok_1" },
        data: expect.objectContaining({
          revokedUseCount: { increment: 1 },
          lastRevokedIp: "1.2.3.4",
        }),
      }),
    );
    expect(sysCreate).toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "tok_1",
        OR: [
          { lastRevokedAlertAt: null },
          {
            lastRevokedAlertAt: {
              lte: new Date(now.getTime() - REVOKED_TOKEN_ALERT_THROTTLE_MS),
            },
          },
        ],
      },
      data: { lastRevokedAlertAt: now },
    });
    expect(userFindMany).toHaveBeenCalledOnce();
  });

  it("does not send another alert when the hourly window is already claimed", async () => {
    findUnique.mockResolvedValue({
      id: "tok_1",
      name: "ci",
      tokenPrefix: "ptr_abc",
      revokedAt: new Date(),
      revokedUseCount: 8,
      lastRevokedUseAt: new Date(),
      lastRevokedAlertAt: new Date(),
    });
    update.mockResolvedValue({ revokedUseCount: 9 });
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      verifyPressureToken(`Bearer ${generatePressureToken()}`),
    ).resolves.toBeNull();

    expect(update).toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalled();
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown token without touching lastUsedAt", async () => {
    findUnique.mockResolvedValue(null);
    await expect(
      verifyPressureToken(`Bearer ${generatePressureToken()}`),
    ).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a missing header without querying at all", async () => {
    await expect(verifyPressureToken(null)).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("still authorizes when the lastUsedAt write fails", async () => {
    findUnique.mockResolvedValue({ id: "tok_1", name: "ci", revokedAt: null });
    update.mockRejectedValue(new Error("db is busy"));
    await expect(
      verifyPressureToken(`Bearer ${generatePressureToken()}`),
    ).resolves.toEqual({
      id: "tok_1",
      name: "ci",
    });
  });
});
