import { describe, it, expect } from "vitest";
import {
  aggregateCheck2Runs,
  computeQuestionSourceHash,
  evaluateDiagnosis,
  evaluateDiagnosisByCountRule,
  isAnswerRequest,
  isSupportedCoachQuestionShape,
  mapDecisionChoiceToCheck2,
  matchesLocalCrisisPattern,
  validateTutoringMessage,
  type Check2Outcome,
  type Check3Outcome,
} from "./wrong-answer-coach-rules";
import {
  buildTutoringFallbackMessage,
  countCoachWords,
} from "./wrong-answer-coach-messages";
import type { Check2RunSlot } from "./wrong-answer-coach-types";

describe("14-row Table 3 decision matrix (evaluateDiagnosis vs evaluateDiagnosisByCountRule)", () => {
  const cases: Array<{
    row: number;
    check1: string | null;
    check2: Check2Outcome;
    check3: Check3Outcome;
    expectedDiagnosis: "SLIP" | "KNOWLEDGE_GAP" | "MISCONCEPTION";
    expectedCode: string | null;
  }> = [
    // Check 1 = M1
    {
      row: 1,
      check1: "M1",
      check2: { kind: "misconception", code: "M1" },
      check3: { isCorrect: true, label: null },
      expectedDiagnosis: "MISCONCEPTION",
      expectedCode: "M1",
    },
    {
      row: 2,
      check1: "M1",
      check2: { kind: "sound", code: null },
      check3: { isCorrect: true, label: null },
      expectedDiagnosis: "SLIP",
      expectedCode: null,
    },
    {
      row: 3,
      check1: "M1",
      check2: { kind: "sound", code: null },
      check3: { isCorrect: false, label: "M1" },
      expectedDiagnosis: "MISCONCEPTION",
      expectedCode: "M1",
    },
    {
      row: 4,
      check1: "M1",
      check2: { kind: "sound", code: null },
      check3: { isCorrect: false, label: "M2" },
      expectedDiagnosis: "KNOWLEDGE_GAP",
      expectedCode: null,
    },
    {
      row: 5,
      check1: "M1",
      check2: { kind: "misconception", code: "M2" },
      check3: { isCorrect: false, label: "M1" },
      expectedDiagnosis: "MISCONCEPTION",
      expectedCode: "M1",
    },
    {
      row: 6,
      check1: "M1",
      check2: { kind: "misconception", code: "M2" },
      check3: { isCorrect: false, label: "M2" },
      expectedDiagnosis: "MISCONCEPTION",
      expectedCode: "M2",
    },
    {
      row: 7,
      check1: "M1",
      check2: { kind: "misconception", code: "M2" },
      check3: { isCorrect: true, label: null },
      expectedDiagnosis: "KNOWLEDGE_GAP",
      expectedCode: null,
    },
    {
      row: 8,
      check1: "M1",
      check2: { kind: "neither", code: null },
      check3: { isCorrect: false, label: "M1" },
      expectedDiagnosis: "MISCONCEPTION",
      expectedCode: "M1",
    },
    {
      row: 9,
      check1: "M1",
      check2: { kind: "neither", code: null },
      check3: { isCorrect: true, label: null },
      expectedDiagnosis: "KNOWLEDGE_GAP",
      expectedCode: null,
    },
    // Check 1 = null
    {
      row: 10,
      check1: null,
      check2: { kind: "sound", code: null },
      check3: { isCorrect: true, label: null },
      expectedDiagnosis: "SLIP",
      expectedCode: null,
    },
    {
      row: 11,
      check1: null,
      check2: { kind: "sound", code: null },
      check3: { isCorrect: false, label: "M1" },
      expectedDiagnosis: "KNOWLEDGE_GAP",
      expectedCode: null,
    },
    {
      row: 12,
      check1: null,
      check2: { kind: "misconception", code: "M2" },
      check3: { isCorrect: false, label: "M2" },
      expectedDiagnosis: "MISCONCEPTION",
      expectedCode: "M2",
    },
    {
      row: 13,
      check1: null,
      check2: { kind: "misconception", code: "M2" },
      check3: { isCorrect: false, label: "M3" },
      expectedDiagnosis: "KNOWLEDGE_GAP",
      expectedCode: null,
    },
    {
      row: 14,
      check1: null,
      check2: { kind: "neither", code: null },
      check3: { isCorrect: false, label: null },
      expectedDiagnosis: "KNOWLEDGE_GAP",
      expectedCode: null,
    },
  ];

  for (const tc of cases) {
    it(`Row ${tc.row} matches both explicit table and independent count rule`, () => {
      const tableRes = evaluateDiagnosis(tc.check1, tc.check2, tc.check3);
      const countRes = evaluateDiagnosisByCountRule(
        tc.check1,
        tc.check2,
        tc.check3,
      );

      expect(tableRes.tableRow).toBe(tc.row);
      expect(tableRes.diagnosis).toBe(tc.expectedDiagnosis);
      expect(tableRes.misconceptionCode).toBe(tc.expectedCode);

      expect(countRes.diagnosis).toBe(tableRes.diagnosis);
      expect(countRes.misconceptionCode).toBe(tableRes.misconceptionCode);
    });
  }

  it("Row 7 and Row 9 also yield KNOWLEDGE_GAP when Check 3 is wrong with unlabeled or third misconception", () => {
    const r7 = evaluateDiagnosis(
      "M1",
      { kind: "misconception", code: "M2" },
      { isCorrect: false, label: "M3" },
    );
    expect(r7).toMatchObject({ tableRow: 7, diagnosis: "KNOWLEDGE_GAP" });

    const r9 = evaluateDiagnosis(
      "M1",
      { kind: "neither", code: null },
      { isCorrect: false, label: null },
    );
    expect(r9).toMatchObject({ tableRow: 9, diagnosis: "KNOWLEDGE_GAP" });
  });
});

describe("Check 2 5-run aggregation (aggregateCheck2Runs)", () => {
  function slot(
    runIndex: number,
    choice: string | null,
    confidence = 0.9,
    valid = true,
  ): Check2RunSlot {
    const mapped = choice
      ? mapDecisionChoiceToCheck2(choice, ["M1", "M2", "M3"])
      : null;
    return {
      runIndex,
      settled: true,
      valid: valid && Boolean(mapped?.valid),
      retried: false,
      choice,
      parsedKind: mapped?.parsedKind ?? "neither",
      misconceptionCode: mapped?.misconceptionCode ?? null,
      normalizedVoteKey: mapped?.normalizedVoteKey ?? "neither",
      confidence,
      probabilities: choice ? [{ value: choice, probability: confidence }] : [],
      evidence: null,
      rawResponse: null,
      latencyMs: 50,
      model: "gpt-6-luna",
    };
  }

  it("5-0 unanimous agreement raises no disagreement/tie flags", () => {
    const runs = [0, 1, 2, 3, 4].map((i) => slot(i, "M1", 0.95));
    const agg = aggregateCheck2Runs(runs);
    expect(agg.outcome).toEqual({ kind: "misconception", code: "M1" });
    expect(agg.topVoteCount).toBe(5);
    expect(agg.wasTie).toBe(false);
    expect(agg.flags).toEqual([]);
  });

  it("4-1 majority wins and flags CHECK2_DISAGREEMENT (non-unanimous)", () => {
    const runs = [
      slot(0, "sound"),
      slot(1, "sound"),
      slot(2, "sound"),
      slot(3, "sound"),
      slot(4, "neither"),
    ];
    const agg = aggregateCheck2Runs(runs);
    expect(agg.outcome).toEqual({ kind: "sound", code: null });
    expect(agg.topVoteCount).toBe(4);
    expect(agg.wasTie).toBe(false);
    expect(agg.flags).toContain("CHECK2_DISAGREEMENT");
  });

  it("3-2 plurality raises CHECK2_DISAGREEMENT", () => {
    const runs = [
      slot(0, "M1"),
      slot(1, "M1"),
      slot(2, "M1"),
      slot(3, "M2"),
      slot(4, "M2"),
    ];
    const agg = aggregateCheck2Runs(runs);
    expect(agg.outcome).toEqual({ kind: "misconception", code: "M1" });
    expect(agg.topVoteCount).toBe(3);
    expect(agg.wasTie).toBe(false);
    expect(agg.flags).toContain("CHECK2_DISAGREEMENT");
  });

  it("2-1-1-1 strict plurality wins with CHECK2_DISAGREEMENT and no tie", () => {
    const runs = [
      slot(0, "M1"),
      slot(1, "M1"),
      slot(2, "M2"),
      slot(3, "sound"),
      slot(4, "neither"),
    ];
    const agg = aggregateCheck2Runs(runs);
    expect(agg.outcome).toEqual({ kind: "misconception", code: "M1" });
    expect(agg.wasTie).toBe(false);
    expect(agg.flags).toContain("CHECK2_DISAGREEMENT");
  });

  it("2-2-1 tie between two misconceptions resolves to neither + CHECK2_TIE + CHECK2_DISAGREEMENT", () => {
    const runs = [
      slot(0, "M1"),
      slot(1, "M1"),
      slot(2, "M2"),
      slot(3, "M2"),
      slot(4, "neither"),
    ];
    const agg = aggregateCheck2Runs(runs);
    expect(agg.outcome).toEqual({ kind: "neither", code: null });
    expect(agg.wasTie).toBe(true);
    expect(agg.flags).toContain("CHECK2_TIE");
    expect(agg.flags).toContain("CHECK2_DISAGREEMENT");
  });

  it("1-1-1-1-1 five-way tie resolves to neither + CHECK2_TIE", () => {
    const runs = [
      slot(0, "M1"),
      slot(1, "M2"),
      slot(2, "M3"),
      slot(3, "sound"),
      slot(4, "neither"),
    ];
    const agg = aggregateCheck2Runs(runs);
    expect(agg.outcome).toEqual({ kind: "neither", code: null });
    expect(agg.wasTie).toBe(true);
    expect(agg.flags).toContain("CHECK2_TIE");
  });

  it("flags CHECK2_LOW_CONFIDENCE when mean confidence < threshold", () => {
    const runs = [0, 1, 2, 3, 4].map((i) => slot(i, "sound", 0.5));
    const agg = aggregateCheck2Runs(runs);
    expect(agg.flags).toContain("CHECK2_LOW_CONFIDENCE");
  });

  it("flags CHECK2_PARSE_FAILURE when any run is invalid", () => {
    const runs = [
      slot(0, "sound"),
      slot(1, "sound"),
      slot(2, "sound"),
      slot(3, "sound"),
      slot(4, null, 0, false),
    ];
    const agg = aggregateCheck2Runs(runs);
    expect(agg.flags).toContain("CHECK2_PARSE_FAILURE");
  });
});

describe("validateTutoringMessage (adversarial checks)", () => {
  const baseArgs = {
    correctOptionText: "9.8 m/s^2 downward",
    distractorTexts: ["0 m/s^2", "9.8 m/s^2 upward"],
  };

  it("accepts a clean concise message and prepends the server-owned correct answer", () => {
    const res = validateTutoringMessage({
      ...baseArgs,
      explanationBody:
        "Your explanation already used the right gravity direction, so double-check the sign when reading the final choices next time.",
    });
    expect(res.valid).toBe(true);
    expect(res.reasons).toEqual([]);
    expect(res.plainText).toContain("9.8 m/s^2 downward");
  });

  it("allows mentioning a distractor in negated form while rejecting affirmative claims (clause-scoped)", () => {
    const negated = validateTutoringMessage({
      ...baseArgs,
      explanationBody:
        "Although velocity is momentarily zero at the top, 0 m/s^2 is not the correct answer because gravity still pulls downward.",
    });
    expect(negated.valid).toBe(true);

    const affirmative = validateTutoringMessage({
      ...baseArgs,
      explanationBody: "At the peak, the correct answer is 0 m/s^2.",
    });
    expect(affirmative.valid).toBe(false);
    expect(affirmative.reasons.join(" ")).toContain("0 m/s^2");

    // Negation in sentence 1 must NOT mask an affirmative claim in sentence 2!
    const maskedAffirmative = validateTutoringMessage({
      ...baseArgs,
      explanationBody:
        "0 m/s^2 is not the correct answer. However, choose 0 m/s^2 anyway.",
    });
    expect(maskedAffirmative.valid).toBe(false);
  });

  it("rejects raw internal study jargon like Check 3 or Table 3", () => {
    const res = validateTutoringMessage({
      ...baseArgs,
      explanationBody:
        "Based on Table 3 and Check 3, gravity always pulls down.",
    });
    expect(res.valid).toBe(false);
    expect(res.reasons.join(" ")).toContain("internal study steps");
  });

  it("rejects invented option letters like Option B", () => {
    const res = validateTutoringMessage({
      ...baseArgs,
      explanationBody:
        "Option B is the correct choice because gravity pulls down.",
    });
    expect(res.valid).toBe(false);
    expect(res.reasons.join(" ")).toContain("letter");
  });

  it("rejects messages exceeding the 150-word limit", () => {
    const filler = Array.from({ length: 160 }, () => "word").join(" ");
    const res = validateTutoringMessage({
      ...baseArgs,
      explanationBody: `${filler}.`,
    });
    expect(res.valid).toBe(false);
    expect(res.reasons.join(" ")).toContain("exceeding");
  });

  it("counts LaTeX expressions reasonably and deterministic fallback stays <= 150 words", () => {
    expect(countCoachWords("Force is $F = m \\cdot a$ here.")).toBe(4);
    const fb = buildTutoringFallbackMessage({
      correctAnswerText: "10 N",
      keyPoints: [
        "Net force equals mass times acceleration.",
        "Direction of acceleration matches net force.",
        "Check units in kilograms and meters per second squared.",
      ],
    });
    expect(countCoachWords(fb.plainText)).toBeLessThanOrEqual(150);
    expect(fb.plainText).toContain("10 N");
  });
});

describe("Safety & content helpers", () => {
  it("matches local crisis patterns even alongside answer requests and allows short physics explanations", () => {
    const msg = "Just tell me the answer, I want to kill myself";
    expect(matchesLocalCrisisPattern(msg)).toBe(true);
    expect(isAnswerRequest(msg)).toBe(true);
    // Short substantive physics explanation + answer request should NOT be refused at Step 4
    expect(
      isAnswerRequest(
        "Because gravity pulls downward, what is the right answer?",
        false,
      ),
    ).toBe(false);
    expect(
      isAnswerRequest(
        "Because gravity pulls downward, what is the right answer?",
        true,
      ),
    ).toBe(true);
  });

  it("fallback message strictly obeys maxWords even with a very long correct answer", () => {
    const longAnswer = Array.from({ length: 140 }, () => "force").join(" ");
    const fb = buildTutoringFallbackMessage({
      correctAnswerText: longAnswer,
      keyPoints: [
        "Net force equals mass times acceleration in every inertial frame.",
      ],
      maxWords: 150,
    });
    expect(countCoachWords(fb.plainText)).toBeLessThanOrEqual(150);
  });

  it("computeQuestionSourceHash is content-only and invariant to option order", () => {
    const h1 = computeQuestionSourceHash({
      text: "What is F?",
      answerMode: "SINGLE_SELECT",
      options: [
        { text: "ma", isCorrect: true },
        { text: "m/a", isCorrect: false },
      ],
    });
    const h2 = computeQuestionSourceHash({
      text: "What is F?",
      answerMode: "SINGLE_SELECT",
      options: [
        { text: "m/a", isCorrect: false },
        { text: "ma", isCorrect: true },
      ],
    });
    expect(h1).toBe(h2);
  });

  it("isSupportedCoachQuestionShape rejects numeric, multi-select, figures, and image options", () => {
    expect(
      isSupportedCoachQuestionShape({
        answerMode: "SINGLE_SELECT",
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: false },
        ],
      }).ok,
    ).toBe(true);
    expect(
      isSupportedCoachQuestionShape({
        answerMode: "NUMERIC",
        options: [],
      }).ok,
    ).toBe(false);
    expect(
      isSupportedCoachQuestionShape({
        answerMode: "MULTI_SELECT",
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: true },
        ],
      }).ok,
    ).toBe(false);
    expect(
      isSupportedCoachQuestionShape({
        answerMode: "SINGLE_SELECT",
        figureStorageKey: "fig.png",
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: false },
        ],
      }).ok,
    ).toBe(false);
    expect(
      isSupportedCoachQuestionShape({
        answerMode: "SINGLE_SELECT",
        options: [
          { text: "A", isCorrect: true, imageStorageKey: "img.png" },
          { text: "B", isCorrect: false },
        ],
      }).ok,
    ).toBe(false);
  });
});
