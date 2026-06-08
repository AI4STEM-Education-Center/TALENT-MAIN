import { describe, it, expect } from "vitest";
import {
  buildReviewSnapshot,
  parseReviewSnapshot,
  snapshotToMisconceptions,
  snapshotToSummaryAttempt,
  parseStoredRecommendations,
  mapPresignedRecommendations,
  MAX_RECOMMENDATIONS,
  type ReviewSnapshot,
  type StoredRecommendations,
} from "./exam-results";
import { buildQuizReviewPrompt } from "./chat-prompt";

// ─── buildReviewSnapshot ────────────────────────────────────────────────────────

describe("buildReviewSnapshot", () => {
  const questions = [
    {
      id: "q1",
      text: "2 + 2?",
      options: [
        { id: "o1", text: "3", isCorrect: false },
        { id: "o2", text: "4", isCorrect: true },
      ],
    },
    {
      id: "q2",
      text: "Capital of France?",
      options: [
        { id: "o3", text: "Paris", isCorrect: true },
        { id: "o4", text: "Rome", isCorrect: false },
      ],
    },
  ];

  it("marks selected and correct options per question", () => {
    const snapshot = buildReviewSnapshot(questions, [
      { questionId: "q1", selectedOptionIds: ["o2"], isCorrect: true },
      { questionId: "q2", selectedOptionIds: ["o4"], isCorrect: false },
    ]);

    expect(snapshot.questions[0]).toEqual({
      text: "2 + 2?",
      isCorrect: true,
      options: [
        { text: "3", isCorrect: false, selected: false },
        { text: "4", isCorrect: true, selected: true },
      ],
    });
    expect(snapshot.questions[1].isCorrect).toBe(false);
    expect(snapshot.questions[1].options.find((o) => o.text === "Rome")?.selected).toBe(true);
  });

  it("treats a question with no answer record as incorrect with nothing selected", () => {
    const snapshot = buildReviewSnapshot(questions, []);
    expect(snapshot.questions[0].isCorrect).toBe(false);
    expect(snapshot.questions[0].options.every((o) => !o.selected)).toBe(true);
  });

  it("supports multiple selected options (multi-select)", () => {
    const snapshot = buildReviewSnapshot(
      [
        {
          id: "q1",
          text: "Pick the even numbers",
          options: [
            { id: "a", text: "2", isCorrect: true },
            { id: "b", text: "3", isCorrect: false },
            { id: "c", text: "4", isCorrect: true },
          ],
        },
      ],
      [{ questionId: "q1", selectedOptionIds: ["a", "c"], isCorrect: true }]
    );
    const selected = snapshot.questions[0].options.filter((o) => o.selected).map((o) => o.text);
    expect(selected).toEqual(["2", "4"]);
  });
});

// ─── parseReviewSnapshot ─────────────────────────────────────────────────────────

describe("parseReviewSnapshot", () => {
  it("round-trips a serialized snapshot", () => {
    const snap: ReviewSnapshot = {
      questions: [{ text: "q", isCorrect: true, options: [{ text: "a", isCorrect: true, selected: true }] }],
    };
    expect(parseReviewSnapshot(JSON.stringify(snap))).toEqual(snap);
  });

  it("returns an empty snapshot for null or invalid JSON", () => {
    expect(parseReviewSnapshot(null)).toEqual({ questions: [] });
    expect(parseReviewSnapshot("not json")).toEqual({ questions: [] });
    expect(parseReviewSnapshot("{}")).toEqual({ questions: [] });
  });
});

// ─── snapshotToMisconceptions ────────────────────────────────────────────────────

describe("snapshotToMisconceptions", () => {
  const snapshot: ReviewSnapshot = {
    questions: [
      {
        text: "Right one",
        isCorrect: true,
        options: [{ text: "a", isCorrect: true, selected: true }],
      },
      {
        text: "Wrong one",
        isCorrect: false,
        options: [
          { text: "good", isCorrect: true, selected: false },
          { text: "bad", isCorrect: false, selected: true },
        ],
      },
      {
        text: "Skipped one",
        isCorrect: false,
        options: [{ text: "good", isCorrect: true, selected: false }],
      },
    ],
  };

  it("returns inputs only for incorrect questions, with wrong/correct answers", () => {
    const { inputs, truncated } = snapshotToMisconceptions(snapshot);
    expect(truncated).toBe(false);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual({
      questionText: "Wrong one",
      wrongAnswer: "bad",
      correctAnswer: "good",
    });
  });

  it("uses 'No answer selected' when nothing was chosen", () => {
    const { inputs } = snapshotToMisconceptions(snapshot);
    expect(inputs[1].wrongAnswer).toBe("No answer selected");
  });

  it("caps at maxCount and reports truncation", () => {
    const many: ReviewSnapshot = {
      questions: Array.from({ length: MAX_RECOMMENDATIONS + 2 }, (_, i) => ({
        text: `q${i}`,
        isCorrect: false,
        options: [
          { text: "c", isCorrect: true, selected: false },
          { text: "w", isCorrect: false, selected: true },
        ],
      })),
    };
    const { inputs, truncated } = snapshotToMisconceptions(many);
    expect(inputs).toHaveLength(MAX_RECOMMENDATIONS);
    expect(truncated).toBe(true);
  });

  it("returns no inputs for a perfect score", () => {
    const perfect: ReviewSnapshot = {
      questions: [{ text: "q", isCorrect: true, options: [{ text: "a", isCorrect: true, selected: true }] }],
    };
    expect(snapshotToMisconceptions(perfect)).toEqual({ inputs: [], truncated: false });
  });
});

// ─── snapshotToSummaryAttempt (+ buildQuizReviewPrompt integration) ───────────────

describe("snapshotToSummaryAttempt", () => {
  const snapshot: ReviewSnapshot = {
    questions: [
      {
        text: "Newton's third law?",
        isCorrect: false,
        options: [
          { text: "Equal and opposite", isCorrect: true, selected: false },
          { text: "Forces vanish", isCorrect: false, selected: true },
        ],
      },
    ],
  };
  const meta = {
    score: 0,
    completedAt: new Date("2026-01-02T03:04:05.000Z"),
    className: "Physics 101",
    topicName: "Forces",
    subtopicName: "Newton's Laws",
  };

  it("maps metadata and per-question answers into the QuizReviewAttempt shape", () => {
    const attempt = snapshotToSummaryAttempt(snapshot, meta);
    expect(attempt.class.name).toBe("Physics 101");
    expect(attempt.subtopic.topic.name).toBe("Forces");
    expect(attempt.answers[0].selectedOption).toEqual({ text: "Forces vanish" });
    expect(attempt.answers[0].isCorrect).toBe(false);
  });

  it("sets selectedOption to null when nothing was selected", () => {
    const noSelection: ReviewSnapshot = {
      questions: [{ text: "q", isCorrect: false, options: [{ text: "a", isCorrect: true, selected: false }] }],
    };
    const attempt = snapshotToSummaryAttempt(noSelection, meta);
    expect(attempt.answers[0].selectedOption).toBeNull();
  });

  it("produces a prompt the summary generator can use", () => {
    const prompt = buildQuizReviewPrompt(snapshotToSummaryAttempt(snapshot, meta));
    expect(prompt).toContain("Class: Physics 101");
    expect(prompt).toContain("Topic: Forces");
    expect(prompt).toContain("Module: Newton's Laws");
    expect(prompt).toContain("Newton's third law?");
  });
});

// ─── parseStoredRecommendations ──────────────────────────────────────────────────

describe("parseStoredRecommendations", () => {
  it("parses a well-formed blob", () => {
    const stored: StoredRecommendations = {
      items: [
        {
          questionText: "q",
          materialTitle: "M",
          pageRange: { start: 1, end: 2 },
          fileReason: "f",
          pageReason: "p",
          pages: [{ pageNumber: 1, storageKey: "k1" }],
        },
      ],
      truncated: true,
    };
    expect(parseStoredRecommendations(JSON.stringify(stored))).toEqual(stored);
  });

  it("falls back to empty for null/invalid/odd shapes", () => {
    expect(parseStoredRecommendations(null)).toEqual({ items: [], truncated: false });
    expect(parseStoredRecommendations("nope")).toEqual({ items: [], truncated: false });
    expect(parseStoredRecommendations('{"items":"x"}')).toEqual({ items: [], truncated: false });
  });
});

// ─── mapPresignedRecommendations ─────────────────────────────────────────────────

describe("mapPresignedRecommendations", () => {
  const stored: StoredRecommendations = {
    items: [
      {
        questionText: "q",
        materialTitle: "M",
        pageRange: { start: 1, end: 2 },
        fileReason: "f",
        pageReason: "p",
        pages: [
          { pageNumber: 1, storageKey: "good-1" },
          { pageNumber: 2, storageKey: "bad-2" },
        ],
      },
    ],
    truncated: true,
  };

  it("replaces each storageKey with a presigned URL", async () => {
    const result = await mapPresignedRecommendations(stored, async (key) => `https://signed/${key}`);
    expect(result.truncated).toBe(true);
    expect(result.items[0].pages).toEqual([
      { pageNumber: 1, imageUrl: "https://signed/good-1" },
      { pageNumber: 2, imageUrl: "https://signed/bad-2" },
    ]);
    // storageKey must not leak into the presigned shape
    expect((result.items[0].pages[0] as Record<string, unknown>).storageKey).toBeUndefined();
  });

  it("drops only the pages whose presign fails", async () => {
    const result = await mapPresignedRecommendations(stored, async (key) => {
      if (key.startsWith("bad")) throw new Error("gone");
      return `https://signed/${key}`;
    });
    expect(result.items[0].pages).toEqual([{ pageNumber: 1, imageUrl: "https://signed/good-1" }]);
  });

  it("returns empty items when there is nothing stored", async () => {
    const result = await mapPresignedRecommendations({ items: [], truncated: false }, async () => "x");
    expect(result).toEqual({ items: [], truncated: false });
  });
});
