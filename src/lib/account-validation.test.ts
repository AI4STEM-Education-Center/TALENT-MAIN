import { describe, it, expect } from "vitest";
import {
  PASSWORD_REQUIREMENTS,
  normalizeEmail,
  normalizeUsername,
  validatePassword,
} from "./account-validation";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
  });
});

describe("normalizeUsername", () => {
  it("trims and lowercases", () => {
    expect(normalizeUsername("  JaneDoe ")).toBe("janedoe");
  });
});

describe("validatePassword", () => {
  it("accepts a password meeting every requirement", () => {
    expect(validatePassword("Abcdef1!")).toBeNull();
  });

  it.each([
    ["too short", "Ab1!"],
    ["no uppercase", "abcdef1!"],
    ["no lowercase", "ABCDEF1!"],
    ["no digit", "Abcdefg!"],
    ["no special char", "Abcdef12"],
  ])("rejects when %s", (_label, password) => {
    expect(validatePassword(password)).toBe(PASSWORD_REQUIREMENTS);
  });

  it("treats whitespace as not satisfying the special-character rule", () => {
    // \s is excluded from the special-character class, so a space alone fails.
    expect(validatePassword("Abcdef1 ")).toBe(PASSWORD_REQUIREMENTS);
  });

  it("accepts exactly 8 characters when all classes are present", () => {
    expect(validatePassword("Abcde1#x")).toBeNull();
  });
});
