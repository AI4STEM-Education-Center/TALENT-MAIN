import { describe, it, expect } from "vitest";
import {
  extractIncorrectAnswerEvidence,
  buildMisconceptionLabelingPrompt,
  buildMisconceptionSchema,
  resolveLabeledMisconceptions,
  MAX_MISCONCEPTIONS,
  type IncorrectAnswerEvidence,
  type MisconceptionCatalogEntry,
} from "./misconception-labeling";
import type { ReviewSnapshot } from "./exam-results";

// ─── extractIncorrectAnswerEvidence ─────────────────────────────────────────────

describe("extractIncorrectAnswerEvidence", () => {
  it("skips correct answers and reports selected/correct option text for wrong choice answers", () => {
    const snapshot: ReviewSnapshot = {
      questions: [
        {
          text: "2 + 2?",
          isCorrect: true,
          options: [
            { text: "3", isCorrect: false, selected: false },
            { text: "4", isCorrect: true, selected: true },
          ],
        },
        {
          text: "Capital of France?",
          isCorrect: false,
          options: [
            { text: "Paris", isCorrect: true, selected: false },
            { text: "Rome", isCorrect: false, selected: true },
          ],
        },
      ],
    };

    const evidence = extractIncorrectAnswerEvidence(snapshot);
    expect(evidence).toEqual<IncorrectAnswerEvidence[]>([
      { questionText: "Capital of France?", studentAnswer: "Rome", correctAnswer: "Paris" },
    ]);
  });

  it("reports 'No answer selected' / 'Unknown' when nothing was selected or nothing is marked correct", () => {
    const snapshot: ReviewSnapshot = {
      questions: [
        {
          text: "Pick one",
          isCorrect: false,
          options: [
            { text: "A", isCorrect: false, selected: false },
            { text: "B", isCorrect: false, selected: false },
          ],
        },
      ],
    };

    const evidence = extractIncorrectAnswerEvidence(snapshot);
    expect(evidence).toEqual([
      { questionText: "Pick one", studentAnswer: "No answer selected", correctAnswer: "Unknown" },
    ]);
  });

  it("joins multiple selected/correct options with a pipe (MULTI_SELECT)", () => {
    const snapshot: ReviewSnapshot = {
      questions: [
        {
          text: "Pick all primes",
          isCorrect: false,
          options: [
            { text: "2", isCorrect: true, selected: true },
            { text: "3", isCorrect: true, selected: false },
            { text: "4", isCorrect: false, selected: true },
          ],
        },
      ],
    };

    const evidence = extractIncorrectAnswerEvidence(snapshot);
    expect(evidence[0].studentAnswer).toBe("2 | 4");
    expect(evidence[0].correctAnswer).toBe("2 | 3");
  });

  it("uses image alt text (or a placeholder) when an option has no text", () => {
    const snapshot: ReviewSnapshot = {
      questions: [
        {
          text: "Which diagram?",
          isCorrect: false,
          options: [
            { text: "", isCorrect: true, selected: false, imageAlt: "Correct diagram" },
            { text: "", isCorrect: false, selected: true, imageStorageKey: "key.png" },
          ],
        },
      ],
    };

    const evidence = extractIncorrectAnswerEvidence(snapshot);
    expect(evidence[0].studentAnswer).toBe("(image choice)");
    expect(evidence[0].correctAnswer).toBe("Correct diagram");
  });

  it("formats NUMERIC questions with unit, and reports 'No answer'/'Unknown' when absent", () => {
    const snapshot: ReviewSnapshot = {
      questions: [
        {
          text: "Mass of an electron?",
          isCorrect: false,
          options: [],
          answerMode: "NUMERIC",
          correctNumeric: 9.1,
          unit: "×10⁻³¹ kg",
          submittedNumeric: 1.6,
        },
        {
          text: "Unanswered numeric",
          isCorrect: false,
          options: [],
          answerMode: "NUMERIC",
          correctNumeric: null,
          submittedNumeric: null,
        },
      ],
    };

    const evidence = extractIncorrectAnswerEvidence(snapshot);
    expect(evidence).toEqual([
      { questionText: "Mass of an electron?", studentAnswer: "1.6 ×10⁻³¹ kg", correctAnswer: "9.1 ×10⁻³¹ kg" },
      { questionText: "Unanswered numeric", studentAnswer: "No answer", correctAnswer: "Unknown" },
    ]);
  });
});

// ─── buildMisconceptionLabelingPrompt ────────────────────────────────────────────

const catalog: MisconceptionCatalogEntry[] = [
  { misconceptionId: "MIS-001", statement: "Believes force is required to sustain motion." },
  { misconceptionId: "MIS-002", statement: "Confuses mass and weight." },
];

const evidence: IncorrectAnswerEvidence[] = [
  { questionText: "Why does a ball keep rolling?", studentAnswer: "A force keeps pushing it", correctAnswer: "Inertia" },
];

describe("buildMisconceptionLabelingPrompt", () => {
  it("includes every catalog entry and every evidence line", () => {
    const prompt = buildMisconceptionLabelingPrompt(evidence, catalog);
    expect(prompt).toContain("[MIS-001] Believes force is required to sustain motion.");
    expect(prompt).toContain("[MIS-002] Confuses mass and weight.");
    expect(prompt).toContain("Why does a ball keep rolling?");
    expect(prompt).toContain("A force keeps pushing it");
    expect(prompt).toContain("Inertia");
  });

  it("instructs the model to choose only from the catalog and cap at 3", () => {
    const prompt = buildMisconceptionLabelingPrompt(evidence, catalog);
    expect(prompt.toLowerCase()).toContain("at most 3");
    expect(prompt.toLowerCase()).toContain("only choose");
    expect(prompt.toLowerCase()).toContain("empty list");
  });
});

// ─── buildMisconceptionSchema ────────────────────────────────────────────────────

describe("buildMisconceptionSchema", () => {
  it("constrains misconception_ids to the given ids with maxItems 3", () => {
    const schema = buildMisconceptionSchema(["MIS-001", "MIS-002"]) as {
      properties: { misconception_ids: { maxItems: number; items: { enum: string[] } } };
      required: string[];
    };
    expect(schema.properties.misconception_ids.maxItems).toBe(MAX_MISCONCEPTIONS);
    expect(schema.properties.misconception_ids.items.enum).toEqual(["MIS-001", "MIS-002"]);
    expect(schema.required).toEqual(["misconception_ids"]);
  });
});

// ─── resolveLabeledMisconceptions ────────────────────────────────────────────────

describe("resolveLabeledMisconceptions", () => {
  it("resolves valid ids to their catalog statement, preserving model order", () => {
    const resolved = resolveLabeledMisconceptions(["MIS-002", "MIS-001"], catalog);
    expect(resolved).toEqual([
      { misconceptionId: "MIS-002", statement: "Confuses mass and weight." },
      { misconceptionId: "MIS-001", statement: "Believes force is required to sustain motion." },
    ]);
  });

  it("drops ids that aren't in the catalog (defense in depth against a schema fallback)", () => {
    const resolved = resolveLabeledMisconceptions(["MIS-999", "MIS-001"], catalog);
    expect(resolved).toEqual([{ misconceptionId: "MIS-001", statement: "Believes force is required to sustain motion." }]);
  });

  it("drops duplicate ids", () => {
    const resolved = resolveLabeledMisconceptions(["MIS-001", "MIS-001"], catalog);
    expect(resolved).toHaveLength(1);
  });

  it("caps at MAX_MISCONCEPTIONS even if the model returns more", () => {
    const bigCatalog: MisconceptionCatalogEntry[] = Array.from({ length: 5 }, (_, i) => ({
      misconceptionId: `MIS-00${i}`,
      statement: `Statement ${i}`,
    }));
    const resolved = resolveLabeledMisconceptions(bigCatalog.map((m) => m.misconceptionId), bigCatalog);
    expect(resolved).toHaveLength(MAX_MISCONCEPTIONS);
  });

  it("returns an empty array when the model returns no ids", () => {
    expect(resolveLabeledMisconceptions([], catalog)).toEqual([]);
  });
});
