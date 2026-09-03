import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock is hoisted above module scope, so the spies have to be too.
const { findUnique, update } = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { pressureResultToken: { findUnique, update } },
}));

import {
  bearerToken,
  generatePressureToken,
  hashPressureToken,
  pressureTokenPrefix,
  verifyPressureToken,
} from "./pressure-token";

beforeEach(() => {
  findUnique.mockReset();
  update.mockReset().mockResolvedValue({});
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
    findUnique.mockResolvedValue({ id: "tok_1", name: "ci", revokedAt: null });

    await expect(verifyPressureToken(`Bearer ${token}`)).resolves.toEqual({
      id: "tok_1",
      name: "ci",
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashPressureToken(token) } })
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tok_1" } })
    );
  });

  it("rejects a revoked token", async () => {
    findUnique.mockResolvedValue({ id: "tok_1", name: "ci", revokedAt: new Date() });
    await expect(verifyPressureToken(`Bearer ${generatePressureToken()}`)).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an unknown token without touching lastUsedAt", async () => {
    findUnique.mockResolvedValue(null);
    await expect(verifyPressureToken(`Bearer ${generatePressureToken()}`)).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a missing header without querying at all", async () => {
    await expect(verifyPressureToken(null)).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("still authorizes when the lastUsedAt write fails", async () => {
    findUnique.mockResolvedValue({ id: "tok_1", name: "ci", revokedAt: null });
    update.mockRejectedValue(new Error("db is busy"));
    await expect(verifyPressureToken(`Bearer ${generatePressureToken()}`)).resolves.toEqual({
      id: "tok_1",
      name: "ci",
    });
  });
});
