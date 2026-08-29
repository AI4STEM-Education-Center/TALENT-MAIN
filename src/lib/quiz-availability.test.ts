import { describe, it, expect } from "vitest";
import { canAttemptAgain, quizAvailability } from "./quiz-availability";

const NOW = new Date("2026-06-15T12:00:00Z");
const EARLIER = new Date("2026-06-01T12:00:00Z");
const LATER = new Date("2026-07-01T12:00:00Z");

const open = { availableFrom: null, availableUntil: null, maxAttempts: null };
const fresh = { completedAttempts: 0, hasAttemptInProgress: false };

describe("quizAvailability", () => {
  it("is unlocked when nothing is configured", () => {
    expect(quizAvailability(open, 0, NOW)).toEqual({
      notOpenYet: false,
      closed: false,
      attemptsExhausted: false,
      locked: false,
    });
  });

  it("locks before the open date and unlocks after it", () => {
    expect(quizAvailability({ ...open, availableFrom: LATER }, 0, NOW)).toMatchObject({
      notOpenYet: true,
      locked: true,
    });
    expect(quizAvailability({ ...open, availableFrom: EARLIER }, 0, NOW)).toMatchObject({
      notOpenYet: false,
      locked: false,
    });
  });

  it("locks after the close date", () => {
    expect(quizAvailability({ ...open, availableUntil: EARLIER }, 0, NOW)).toMatchObject({
      closed: true,
      locked: true,
    });
    expect(quizAvailability({ ...open, availableUntil: LATER }, 0, NOW)).toMatchObject({
      closed: false,
      locked: false,
    });
  });

  it("locks once the attempt cap is reached", () => {
    const capped = { ...open, maxAttempts: 2 };
    expect(quizAvailability(capped, 1, NOW).attemptsExhausted).toBe(false);
    expect(quizAvailability(capped, 2, NOW).attemptsExhausted).toBe(true);
    expect(quizAvailability(capped, 3, NOW).attemptsExhausted).toBe(true);
  });

  it("treats maxAttempts 0 as unlimited, matching the schema's null/0 convention", () => {
    expect(quizAvailability({ ...open, maxAttempts: 0 }, 99, NOW).attemptsExhausted).toBe(false);
  });
});

describe("canAttemptAgain", () => {
  it("is true for an open, uncapped quiz", () => {
    expect(canAttemptAgain(open, fresh, NOW)).toBe(true);
  });

  it("is false once the attempt cap is used up", () => {
    expect(
      canAttemptAgain({ ...open, maxAttempts: 1 }, { ...fresh, completedAttempts: 1 }, NOW)
    ).toBe(false);
  });

  it("is false after the quiz closes", () => {
    expect(canAttemptAgain({ ...open, availableUntil: EARLIER }, fresh, NOW)).toBe(false);
  });

  it("is false when the quiz is no longer offered to the class", () => {
    expect(canAttemptAgain(null, fresh, NOW)).toBe(false);
  });

  it("is true while the window has not opened yet — it will", () => {
    expect(canAttemptAgain({ ...open, availableFrom: LATER }, fresh, NOW)).toBe(true);
  });

  it("is true for an unfinished attempt even past the cap or the close date", () => {
    const inProgress = { completedAttempts: 5, hasAttemptInProgress: true };
    // POST /api/quiz resumes an unfinished attempt rather than allocating one, so
    // these answers can still be graded however locked a new attempt would be.
    expect(canAttemptAgain({ ...open, maxAttempts: 1 }, inProgress, NOW)).toBe(true);
    expect(canAttemptAgain({ ...open, availableUntil: EARLIER }, inProgress, NOW)).toBe(true);
    // Even with the quiz pulled from the class entirely.
    expect(canAttemptAgain(null, inProgress, NOW)).toBe(true);
  });
});
