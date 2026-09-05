import { describe, it, expect } from "vitest";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  formatTeacherCode,
  normalizeTeacherCode,
  teacherCodeStatus,
} from "./teacher-codes";
import { generateTeacherCode } from "./teacher-registration-codes";

const NOW = new Date("2026-08-26T12:00:00Z");
const base = { active: true, expiresAt: null, maxUses: null, usedCount: 0 };

describe("generateTeacherCode", () => {
  it("emits CODE_LENGTH characters, all from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateTeacherCode();
      expect(code).toHaveLength(CODE_LENGTH);
      for (const char of code) expect(CODE_ALPHABET).toContain(char);
    }
  });

  it("does not repeat itself", () => {
    const codes = new Set(Array.from({ length: 200 }, generateTeacherCode));
    expect(codes.size).toBe(200);
  });
});

describe("normalizeTeacherCode", () => {
  it("upper-cases and strips the separators a code is displayed with", () => {
    expect(normalizeTeacherCode(" 2b3c-4d5e-6f7g-8h9j ")).toBe(
      "2B3C4D5E6F7G8H9J",
    );
  });

  it("folds the glyphs left out of the alphabet onto what they are mistaken for", () => {
    expect(normalizeTeacherCode("ol1i-2345")).toBe("01112345");
    expect(normalizeTeacherCode("0L11 2345")).toBe("01112345");
    expect(normalizeTeacherCode("uv")).toBe("0V");
  });

  it("is a fixed point on the codes it generates", () => {
    const code = generateTeacherCode();
    expect(normalizeTeacherCode(code)).toBe(code);
    expect(normalizeTeacherCode(formatTeacherCode(code))).toBe(code);
  });

  it("returns an empty string for input with nothing code-like in it", () => {
    expect(normalizeTeacherCode("   ---   ")).toBe("");
  });

  it("caps how much input it will scan", () => {
    expect(normalizeTeacherCode("A".repeat(5000))).toHaveLength(200);
  });
});

describe("formatTeacherCode", () => {
  it("groups into dash-separated quads", () => {
    expect(formatTeacherCode("2B3C4D5E6F7G8H9J")).toBe("2B3C-4D5E-6F7G-8H9J");
  });

  it("leaves a short or empty code alone rather than throwing", () => {
    expect(formatTeacherCode("2B3")).toBe("2B3");
    expect(formatTeacherCode("")).toBe("");
  });
});

describe("teacherCodeStatus", () => {
  it("is ACTIVE for an unlimited, unexpiring code", () => {
    expect(teacherCodeStatus(base, NOW)).toBe("ACTIVE");
  });

  it("reports revocation ahead of expiry and exhaustion", () => {
    const dead = {
      active: false,
      expiresAt: new Date(NOW.getTime() - 1000),
      maxUses: 1,
      usedCount: 1,
    };
    expect(teacherCodeStatus(dead, NOW)).toBe("REVOKED");
  });

  it("is EXPIRED once expiresAt has been reached", () => {
    expect(teacherCodeStatus({ ...base, expiresAt: NOW }, NOW)).toBe("EXPIRED");
    expect(
      teacherCodeStatus(
        { ...base, expiresAt: new Date(NOW.getTime() + 1000) },
        NOW,
      ),
    ).toBe("ACTIVE");
  });

  it("is EXHAUSTED at the use limit but not below it", () => {
    expect(teacherCodeStatus({ ...base, maxUses: 3, usedCount: 2 }, NOW)).toBe(
      "ACTIVE",
    );
    expect(teacherCodeStatus({ ...base, maxUses: 3, usedCount: 3 }, NOW)).toBe(
      "EXHAUSTED",
    );
  });

  it("treats a zero use limit as exhausted, not unlimited", () => {
    expect(teacherCodeStatus({ ...base, maxUses: 0, usedCount: 0 }, NOW)).toBe(
      "EXHAUSTED",
    );
  });
});
