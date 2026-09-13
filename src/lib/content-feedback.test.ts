import { describe, it, expect } from "vitest";
import {
  FEEDBACK_RATING_SCALE,
  feedbackSubjectKey,
  formatAverageRating,
  isValidRating,
  summarizeFeedback,
  summarizeFeedbackBySubject,
  type FeedbackRatingRecord,
} from "@/lib/content-feedback";

const row = (
  overrides: Partial<FeedbackRatingRecord> = {},
): FeedbackRatingRecord => ({
  audience: "STUDENT",
  subjectType: "SIMULATION",
  subjectId: "sim-1",
  subjectLabel: "Waves",
  rating: 4,
  ...overrides,
});

describe("the 5-point scale", () => {
  it("runs 1 through 5", () => {
    expect(FEEDBACK_RATING_SCALE).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects everything outside the scale", () => {
    for (const value of [0, 6, 3.5, -1, "4", null, undefined, NaN]) {
      expect(isValidRating(value)).toBe(false);
    }
    for (const value of FEEDBACK_RATING_SCALE) {
      expect(isValidRating(value)).toBe(true);
    }
  });
});

describe("feedbackSubjectKey", () => {
  it("identifies a simulation by id", () => {
    const key = feedbackSubjectKey({
      subjectType: "SIMULATION",
      subjectId: "sim-1",
      subjectLabel: "Waves",
      attemptId: "att-1",
    });
    expect(key).toBe("SIMULATION|id:sim-1|attempt:att-1");
  });

  it("identifies a material by its normalized title, since it has no id", () => {
    const a = feedbackSubjectKey({
      subjectType: "MATERIAL",
      subjectLabel: "  Chapter   3: Waves ",
      attemptId: "att-1",
    });
    const b = feedbackSubjectKey({
      subjectType: "MATERIAL",
      subjectLabel: "chapter 3: waves",
      attemptId: "att-1",
    });
    expect(a).toBe(b);
  });

  it("keeps a later attempt's verdict separate from an earlier one", () => {
    const first = feedbackSubjectKey({
      subjectType: "SIMULATION",
      subjectId: "sim-1",
      subjectLabel: "Waves",
      attemptId: "att-1",
    });
    const second = feedbackSubjectKey({
      subjectType: "SIMULATION",
      subjectId: "sim-1",
      subjectLabel: "Waves",
      attemptId: "att-2",
    });
    expect(first).not.toBe(second);
  });

  it("does not confuse a material with a simulation of the same name", () => {
    expect(
      feedbackSubjectKey({ subjectType: "MATERIAL", subjectLabel: "Waves" }),
    ).not.toBe(
      feedbackSubjectKey({ subjectType: "SIMULATION", subjectLabel: "Waves" }),
    );
  });
});

describe("summarizeFeedback", () => {
  it("counts, averages, and reports every point of the histogram", () => {
    const summary = summarizeFeedback([
      row({ rating: 5 }),
      row({ rating: 4 }),
      row({ rating: 4 }),
      row({ rating: 1 }),
    ]);
    expect(summary.count).toBe(4);
    expect(summary.average).toBe(3.5);
    expect(summary.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 2, 5: 1 });
  });

  it("returns a null average rather than 0 when there is nothing to average", () => {
    const summary = summarizeFeedback([]);
    expect(summary.count).toBe(0);
    expect(summary.average).toBeNull();
    expect(formatAverageRating(summary.average)).toBe("—");
  });

  it("ignores out-of-scale ratings instead of skewing the mean", () => {
    const summary = summarizeFeedback([
      row({ rating: 4 }),
      row({ rating: 99 }),
      row({ rating: 0 }),
    ]);
    expect(summary.count).toBe(1);
    expect(summary.average).toBe(4);
  });
});

describe("summarizeFeedbackBySubject", () => {
  it("puts the worst average first, breaking ties on volume", () => {
    const rows = [
      row({ subjectId: "good", subjectLabel: "Good sim", rating: 5 }),
      row({ subjectId: "bad", subjectLabel: "Bad sim", rating: 2 }),
      row({ subjectId: "bad", subjectLabel: "Bad sim", rating: 2 }),
      row({ subjectId: "lonely", subjectLabel: "Lonely sim", rating: 2 }),
    ];
    expect(
      summarizeFeedbackBySubject(rows).map((r) => [r.subjectLabel, r.count]),
    ).toEqual([
      ["Bad sim", 2],
      ["Lonely sim", 1],
      ["Good sim", 1],
    ]);
  });

  it("groups a material by title across attempts", () => {
    const rows = [
      row({
        subjectType: "MATERIAL",
        subjectId: null,
        subjectLabel: "Chapter 3",
        rating: 1,
      }),
      row({
        subjectType: "MATERIAL",
        subjectId: null,
        subjectLabel: "chapter 3",
        rating: 3,
      }),
    ];
    const grouped = summarizeFeedbackBySubject(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].count).toBe(2);
    expect(grouped[0].average).toBe(2);
  });
});
