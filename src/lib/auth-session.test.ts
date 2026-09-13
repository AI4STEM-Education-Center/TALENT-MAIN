import { describe, expect, it } from "vitest";
import {
  isSessionExpired,
  ONE_DAY_SECONDS,
  remainingSessionSeconds,
  sessionExpiresAt,
  shouldRememberComputer,
  THIRTY_DAYS_SECONDS,
} from "./auth-session";

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;

describe("auth session lifetime", () => {
  it("only opts in to remembering for the literal checked value", () => {
    expect(shouldRememberComputer("true")).toBe(true);
    expect(shouldRememberComputer("false")).toBe(false);
    expect(shouldRememberComputer(undefined)).toBe(false);
    expect(shouldRememberComputer(true)).toBe(false);
  });

  it("expires a normal sign-in after one day", () => {
    expect(sessionExpiresAt(false, NOW_MS)).toBe(NOW_SECONDS + ONE_DAY_SECONDS);
  });

  it("expires a remembered sign-in after thirty days", () => {
    expect(sessionExpiresAt(true, NOW_MS)).toBe(
      NOW_SECONDS + THIRTY_DAYS_SECONDS,
    );
  });

  it("does not let refreshes extend the absolute deadline", () => {
    const expiresAt = sessionExpiresAt(false, NOW_MS);
    expect(
      remainingSessionSeconds(expiresAt, NOW_MS + 6 * 60 * 60 * 1000),
    ).toBe(18 * 60 * 60);
    expect(isSessionExpired(expiresAt, NOW_MS + ONE_DAY_SECONDS * 1000)).toBe(
      true,
    );
    expect(
      remainingSessionSeconds(expiresAt, NOW_MS + 2 * ONE_DAY_SECONDS * 1000),
    ).toBe(0);
  });

  it("fails closed when an older token has no absolute deadline", () => {
    expect(isSessionExpired(undefined, NOW_MS)).toBe(true);
    expect(remainingSessionSeconds(undefined, NOW_MS)).toBe(0);
  });
});
