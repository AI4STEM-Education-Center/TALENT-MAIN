import { describe, it, expect } from "vitest";
import {
  QUIZ_EXTRACTION_SCHEMA,
  buildExtractionPrompt,
  validateExtractedQuiz,
  normalizeExtractedQuiz,
  validateCommitQuestions,
  mapStagedToQuestionData,
  parseStagedQuestions,
  LATEX_INLINE_DELIMITER,
  type StagedQuestion,
} from "./quiz-extraction";

// ─── Raw LLM payload fixtures (snake_case wire format) ──────────────────────────

type RawOption = { text: string; is_correct: boolean | null };
type RawQuestion = Record<string, unknown>;

function rawOption(text: string, isCorrect: boolean | null = null): RawOption {
  return { text, is_correct: isCorrect };
}

/** A fully-formed raw question with sensible defaults; override per test. */
function rawQuestion(overrides: Partial<RawQuestion> = {}): RawQuestion {
  return {
    number: 1,
    page: 1,
    type: "multiple_choice",
    text: "What is $2 + 2$?",
    points: 1,
    options: [rawOption("3", false), rawOption("4", true)],
    numeric_answer: null,
    numeric_answer_text: null,
    numeric_unit: null,
    has_figure: false,
    figure_page: null,
    figure_bbox: null,
    figure_caption: null,
    confidence: 0.9,
    needs_review: false,
    review_note: null,
    ...overrides,
  };
}

/** A valid full-answer-key payload mirroring the real sample quiz: MC + TF + numeric. */
function rawQuizPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    has_answer_key: true,
    quiz_title: "Physics Quiz 3",
    questions: [
      rawQuestion({
        number: 1,
        type: "multiple_choice",
        text: "Which expresses static friction? $f_s = \\mu_s N$",
        options: [rawOption("$\\mu_s N$", true), rawOption("$\\mu_k N$", false), rawOption("$N$", false)],
      }),
      rawQuestion({
        number: 2,
        type: "true_false",
        text: "Friction always opposes motion.",
        points: 1,
        options: [rawOption("True", false), rawOption("False", true)],
      }),
      rawQuestion({
        number: 3,
        type: "numeric",
        text: "Compute the speed in m/s.",
        options: [],
        numeric_answer: 3.21,
        numeric_answer_text: "3.21",
        numeric_unit: "m/s",
      }),
    ],
    ...overrides,
  };
}

// ─── validateExtractedQuiz ──────────────────────────────────────────────────────

describe("validateExtractedQuiz", () => {
  it("validates a full answer-key payload (MC + TF + numeric)", () => {
    const quiz = validateExtractedQuiz(rawQuizPayload());
    expect(quiz.hasAnswerKey).toBe(true);
    expect(quiz.quizTitle).toBe("Physics Quiz 3");
    expect(quiz.questions).toHaveLength(3);

    const [mc, tf, numeric] = quiz.questions;
    expect(mc.type).toBe("MULTIPLE_CHOICE");
    expect(mc.options.filter((o) => o.isCorrect === true).map((o) => o.text)).toEqual(["$\\mu_s N$"]);
    expect(tf.type).toBe("TRUE_FALSE");
    expect(numeric.type).toBe("NUMERIC");
    expect(numeric.numericAnswer).toBe(3.21);
    expect(numeric.numericAnswerText).toBe("3.21");
    expect(numeric.numericUnit).toBe("m/s");
    expect(numeric.sourcePage).toBe(1);
    expect(numeric.figureStorageKey).toBeNull();
  });

  it("accepts a no-answer-key payload with all-null correctness", () => {
    const payload = rawQuizPayload({
      has_answer_key: false,
      questions: [
        rawQuestion({ options: [rawOption("3", null), rawOption("4", null)] }),
        rawQuestion({ type: "numeric", options: [], numeric_answer: null, numeric_answer_text: null }),
      ],
    });
    const quiz = validateExtractedQuiz(payload);
    expect(quiz.hasAnswerKey).toBe(false);
    expect(quiz.questions[0].options.every((o) => o.isCorrect === null)).toBe(true);
    expect(quiz.questions[1].numericAnswer).toBeNull();
  });

  it("rejects a non-object payload", () => {
    expect(() => validateExtractedQuiz(null)).toThrow(/must be an object/i);
    expect(() => validateExtractedQuiz([])).toThrow(/must be an object/i);
  });

  it("rejects questions that is not an array", () => {
    expect(() => validateExtractedQuiz({ has_answer_key: true, quiz_title: null, questions: {} })).toThrow(
      /questions must be an array/i
    );
  });

  it("rejects an unexpected type enum with the index in the message", () => {
    const payload = rawQuizPayload({
      questions: [rawQuestion(), rawQuestion(), rawQuestion({ type: "essay" })],
    });
    expect(() => validateExtractedQuiz(payload)).toThrow(/questions\[2\]\.type: unexpected value "essay"/);
  });

  it("rejects a non-numeric confidence", () => {
    const payload = rawQuizPayload({ questions: [rawQuestion({ confidence: "high" })] });
    expect(() => validateExtractedQuiz(payload)).toThrow(/confidence: must be a number/i);
  });

  it("clamps confidence into [0,1]", () => {
    const payload = rawQuizPayload({
      questions: [rawQuestion({ confidence: 1.7 }), rawQuestion({ confidence: -0.3 })],
    });
    const quiz = validateExtractedQuiz(payload);
    expect(quiz.questions[0].confidence).toBe(1);
    expect(quiz.questions[1].confidence).toBe(0);
  });

  it("rounds points to an integer", () => {
    const quiz = validateExtractedQuiz(rawQuizPayload({ questions: [rawQuestion({ points: 2.4 })] }));
    expect(quiz.questions[0].points).toBe(2);
  });

  it("nulls a malformed figure_bbox instead of throwing", () => {
    const payload = rawQuizPayload({
      questions: [
        rawQuestion({ has_figure: true, figure_page: 1, figure_bbox: { x: 0.1, y: 0.1, w: "wide", h: 0.5 } }),
      ],
    });
    const quiz = validateExtractedQuiz(payload);
    expect(quiz.questions[0].figureBbox).toBeNull();
    expect(quiz.questions[0].hasFigure).toBe(true);
  });

  it("clamps a valid figure_bbox into page coordinates", () => {
    const payload = rawQuizPayload({
      questions: [rawQuestion({ has_figure: true, figure_page: 2, figure_bbox: { x: -0.2, y: 1.5, w: 2, h: 0.4 } })],
    });
    const quiz = validateExtractedQuiz(payload);
    expect(quiz.questions[0].figureBbox).toEqual({ x: 0, y: 1, w: 1, h: 0.4 });
  });
});

// ─── normalizeExtractedQuiz ─────────────────────────────────────────────────────

describe("normalizeExtractedQuiz", () => {
  it("drops a question with empty text and warns", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({ questions: [rawQuestion({ text: "   " }), rawQuestion()] })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions).toHaveLength(1);
    expect(result.warnings).toContain("dropped question 1: empty text");
  });

  it("strips an artifact glyph option and warns", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({ options: [rawOption("3", false), rawOption("4", true), rawOption("◄▬►", false)] }),
        ],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].options.map((o) => o.text)).toEqual(["3", "4"]);
    expect(result.warnings.some((w) => /stripped 1 artifact option/.test(w))).toBe(true);
  });

  it("dedupes identical options, preferring the correct copy", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({ options: [rawOption("4", false), rawOption("4", true), rawOption("5", false)] }),
        ],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    const q = result.questions[0];
    expect(q.options.map((o) => o.text)).toEqual(["4", "5"]);
    expect(q.options[0].isCorrect).toBe(true);
    expect(result.warnings.some((w) => /removed duplicate option/.test(w))).toBe(true);
  });

  it("converts a MULTIPLE_CHOICE with two marked-correct into MULTI_SELECT", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({
            type: "multiple_choice",
            options: [rawOption("a", true), rawOption("b", true), rawOption("c", false)],
          }),
        ],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].type).toBe("MULTI_SELECT");
    expect(result.questions[0].needsReview).toBe(true);
    expect(result.questions[0].reviewNote).toMatch(/multi-select/i);
  });

  it("coerces true/false options from lowercase/mixed-case labels", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({
            type: "true_false",
            options: [rawOption("true", true), rawOption("FALSE", false)],
          }),
        ],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].options).toEqual([
      { text: "True", isCorrect: true },
      { text: "False", isCorrect: false },
    ]);
  });

  it("flags an ambiguous true/false (both marked) for review with both null", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({ type: "true_false", options: [rawOption("True", true), rawOption("False", true)] }),
        ],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].options.every((o) => o.isCorrect === null)).toBe(true);
    expect(result.questions[0].needsReview).toBe(true);
  });

  it("coerces numeric text to a number while preserving the verbatim text", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({
            type: "numeric",
            options: [],
            numeric_answer: null,
            numeric_answer_text: "3.21",
            numeric_unit: "m/s",
          }),
        ],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].numericAnswer).toBe(3.21);
    expect(result.questions[0].numericAnswerText).toBe("3.21");
  });

  it("clears stray options on a numeric question and warns", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({
            type: "numeric",
            options: [rawOption("3.21", null)],
            numeric_answer: 3.21,
            numeric_answer_text: "3.21",
          }),
        ],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].options).toEqual([]);
    expect(result.warnings.some((w) => /numeric question had options/.test(w))).toBe(true);
  });

  it("forces needsReview on a figure question", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({ has_figure: true, figure_page: 1, figure_bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }),
        ],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].needsReview).toBe(true);
    expect(result.questions[0].reviewNote).toMatch(/figure crop/i);
  });

  it("flags an unmarked choice question for review when an answer key is present", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [rawQuestion({ options: [rawOption("a", false), rawOption("b", false)] })],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].needsReview).toBe(true);
    expect(result.questions[0].reviewNote).toMatch(/no correct option marked/i);
  });

  it("forces all correctness null and review when there is no answer key", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        has_answer_key: false,
        questions: [
          rawQuestion({ options: [rawOption("a", true), rawOption("b", false)] }),
          rawQuestion({
            type: "numeric",
            options: [],
            numeric_answer: 5,
            numeric_answer_text: "5",
          }),
        ],
      })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].options.every((o) => o.isCorrect === null)).toBe(true);
    expect(result.questions[1].numericAnswer).toBeNull();
    expect(result.questions.every((q) => q.needsReview)).toBe(true);
    expect(result.questions.every((q) => /no answer key/i.test(q.reviewNote ?? ""))).toBe(true);
  });

  it("does not mutate a deep-frozen input", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({ options: [rawOption("3", false), rawOption("4", true), rawOption("◄▬►", false)] }),
        ],
      })
    );
    const deepFreeze = (obj: unknown): void => {
      if (obj && typeof obj === "object") {
        Object.values(obj).forEach(deepFreeze);
        Object.freeze(obj);
      }
    };
    deepFreeze(quiz);
    expect(() => normalizeExtractedQuiz(quiz)).not.toThrow();
    // Original is untouched: still has the artifact option.
    expect(quiz.questions[0].options).toHaveLength(3);
  });
});

// ─── validateCommitQuestions ────────────────────────────────────────────────────

function commitQuestion(overrides: Partial<StagedQuestion> = {}): Record<string, unknown> {
  return {
    type: "MULTIPLE_CHOICE",
    text: "What is $2 + 2$?",
    points: 1,
    options: [
      { text: "3", isCorrect: false },
      { text: "4", isCorrect: true },
    ],
    numericAnswer: null,
    numericAnswerText: null,
    numericUnit: null,
    hasFigure: false,
    figurePage: null,
    figureBbox: null,
    figureCaption: null,
    figureStorageKey: null,
    sourcePage: 1,
    confidence: 0.9,
    needsReview: false,
    reviewNote: null,
    ...overrides,
  };
}

describe("validateCommitQuestions", () => {
  it("accepts a fully resolved set of all four types", () => {
    const result = validateCommitQuestions([
      commitQuestion(),
      commitQuestion({
        type: "TRUE_FALSE",
        options: [
          { text: "True", isCorrect: true },
          { text: "False", isCorrect: false },
        ],
      }),
      commitQuestion({
        type: "MULTI_SELECT",
        options: [
          { text: "a", isCorrect: true },
          { text: "b", isCorrect: true },
          { text: "c", isCorrect: false },
        ],
      }),
      commitQuestion({ type: "NUMERIC", options: [], numericAnswer: 3.21, numericUnit: "m/s" }),
      commitQuestion({
        hasFigure: true,
        figureStorageKey: "uploads/fig-1.png",
        figurePage: 2,
        figureCaption: "A free-body diagram",
      }),
    ]);
    expect(result).toHaveLength(5);
    expect(result[4].figureStorageKey).toBe("uploads/fig-1.png");
  });

  it("rejects a non-array payload", () => {
    expect(() => validateCommitQuestions({})).toThrow(/must be an array/i);
  });

  it("rejects a null isCorrect with the index", () => {
    expect(() =>
      validateCommitQuestions([commitQuestion({ options: [{ text: "a", isCorrect: null }, { text: "b", isCorrect: true }] as never })])
    ).toThrow(/question 1: every option must have isCorrect set/i);
  });

  it("rejects a multiple-choice with zero correct", () => {
    expect(() =>
      validateCommitQuestions([
        commitQuestion({ options: [{ text: "a", isCorrect: false }, { text: "b", isCorrect: false }] as never }),
      ])
    ).toThrow(/question 1: MULTIPLE_CHOICE question must have exactly one correct option/i);
  });

  it("rejects a single-option multiple-choice", () => {
    expect(() =>
      validateCommitQuestions([commitQuestion({ options: [{ text: "only", isCorrect: true }] as never })])
    ).toThrow(/question 1: MULTIPLE_CHOICE question must have at least 2 options/i);
  });

  it("rejects a NUMERIC question without a numericAnswer", () => {
    expect(() =>
      validateCommitQuestions([commitQuestion({ type: "NUMERIC", options: [], numericAnswer: null })])
    ).toThrow(/question 1: NUMERIC question requires a numericAnswer/i);
  });

  it("rejects hasFigure without a figureStorageKey", () => {
    expect(() =>
      validateCommitQuestions([commitQuestion({ hasFigure: true, figureStorageKey: null })])
    ).toThrow(/question 1: hasFigure is true but figureStorageKey is missing/i);
  });

  it("rejects empty text with the index", () => {
    expect(() => validateCommitQuestions([commitQuestion(), commitQuestion({ text: "   " })])).toThrow(
      /question 2: text is required/i
    );
  });
});

// ─── buildExtractionPrompt ──────────────────────────────────────────────────────

describe("buildExtractionPrompt", () => {
  const prompt = buildExtractionPrompt(7);

  it("mentions the page count", () => {
    expect(prompt).toContain("7 page images");
  });

  it("singularizes the page count for one page", () => {
    expect(buildExtractionPrompt(1)).toContain("1 page image,");
  });

  it("includes the green checkmark / green bold answer-key rule", () => {
    expect(prompt).toMatch(/green checkmark/i);
    expect(prompt).toMatch(/green bold/i);
  });

  it("includes the never-guess instruction for a missing key", () => {
    expect(prompt).toMatch(/never infer, guess, or solve/i);
  });

  it("includes the $ LaTeX instruction", () => {
    expect(prompt).toContain(LATEX_INLINE_DELIMITER);
    expect(prompt).toMatch(/faithfully as LaTeX/i);
  });

  it("includes the artifact-ignoring instruction", () => {
    expect(prompt).toMatch(/scrollbar/i);
    expect(prompt).toContain("◄▬►");
  });

  it("includes the bounding-box figure instruction", () => {
    expect(prompt).toMatch(/figure_bbox/);
    expect(prompt).toMatch(/0\.\.1 page coordinates/i);
  });

  it("is deterministic for a given page count", () => {
    expect(buildExtractionPrompt(5)).toBe(buildExtractionPrompt(5));
  });
});

// ─── mapStagedToQuestionData ────────────────────────────────────────────────────

const CTX = { quizId: "quiz-1", importId: "import-1", createdById: "teacher-1", figureBucket: "bucket-1" };

function staged(overrides: Partial<StagedQuestion> = {}): StagedQuestion {
  return {
    type: "MULTIPLE_CHOICE",
    text: "What is $2 + 2$?",
    points: 1,
    options: [
      { text: "3", isCorrect: false },
      { text: "4", isCorrect: true },
    ],
    numericAnswer: null,
    numericAnswerText: null,
    numericUnit: null,
    hasFigure: false,
    figurePage: null,
    figureBbox: null,
    figureCaption: null,
    figureStorageKey: null,
    sourcePage: 1,
    confidence: 0.9,
    needsReview: false,
    reviewNote: null,
    ...overrides,
  };
}

describe("mapStagedToQuestionData", () => {
  it("maps a MULTIPLE_CHOICE to SINGLE_SELECT with options", () => {
    const data = mapStagedToQuestionData(staged(), CTX);
    expect(data.answerMode).toBe("SINGLE_SELECT");
    expect(data.quizId).toBe("quiz-1");
    expect(data.importId).toBe("import-1");
    expect(data.createdById).toBe("teacher-1");
    expect(data.options.create).toEqual([
      { text: "3", isCorrect: false },
      { text: "4", isCorrect: true },
    ]);
    expect(data.answerNumeric).toBeNull();
    expect("figureStorageKey" in data).toBe(false);
  });

  it("maps a TRUE_FALSE to SINGLE_SELECT", () => {
    const data = mapStagedToQuestionData(
      staged({
        type: "TRUE_FALSE",
        options: [
          { text: "True", isCorrect: true },
          { text: "False", isCorrect: false },
        ],
      }),
      CTX
    );
    expect(data.answerMode).toBe("SINGLE_SELECT");
    expect(data.options.create).toHaveLength(2);
  });

  it("maps a MULTI_SELECT to MULTI_SELECT", () => {
    const data = mapStagedToQuestionData(
      staged({
        type: "MULTI_SELECT",
        options: [
          { text: "a", isCorrect: true },
          { text: "b", isCorrect: true },
          { text: "c", isCorrect: false },
        ],
      }),
      CTX
    );
    expect(data.answerMode).toBe("MULTI_SELECT");
    expect(data.options.create.filter((o) => o.isCorrect)).toHaveLength(2);
  });

  it("maps a NUMERIC question to NUMERIC with answerNumeric/unit and no options", () => {
    const data = mapStagedToQuestionData(
      staged({ type: "NUMERIC", options: [], numericAnswer: 3.21, numericUnit: "m/s" }),
      CTX
    );
    expect(data.answerMode).toBe("NUMERIC");
    expect(data.answerNumeric).toBe(3.21);
    expect(data.answerTolerance).toBeNull();
    expect(data.answerUnit).toBe("m/s");
    expect(data.options.create).toEqual([]);
  });

  it("includes figure fields only when hasFigure", () => {
    const data = mapStagedToQuestionData(
      staged({ hasFigure: true, figureStorageKey: "uploads/fig.png", figureCaption: "A diagram" }),
      CTX
    );
    expect(data.figureStorageKey).toBe("uploads/fig.png");
    expect(data.figureBucket).toBe("bucket-1");
    expect(data.figureAlt).toBe("A diagram");
  });

  it("coerces a null isCorrect to false in mapped options", () => {
    const data = mapStagedToQuestionData(
      staged({ options: [{ text: "a", isCorrect: null }, { text: "b", isCorrect: true }] }),
      CTX
    );
    expect(data.options.create).toEqual([
      { text: "a", isCorrect: false },
      { text: "b", isCorrect: true },
    ]);
  });
});

// ─── parseStagedQuestions ───────────────────────────────────────────────────────

describe("parseStagedQuestions", () => {
  it("parses a valid JSON array", () => {
    const json = JSON.stringify([staged()]);
    const result = parseStagedQuestions(json);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("What is $2 + 2$?");
  });

  it("returns [] for null", () => {
    expect(parseStagedQuestions(null)).toEqual([]);
  });

  it("returns [] for garbage JSON", () => {
    expect(parseStagedQuestions("{not json")).toEqual([]);
  });

  it("returns [] for a non-array JSON value", () => {
    expect(parseStagedQuestions(JSON.stringify({ questions: [] }))).toEqual([]);
  });
});

// ─── QUIZ_EXTRACTION_SCHEMA shape sanity ────────────────────────────────────────

describe("QUIZ_EXTRACTION_SCHEMA", () => {
  it("is a strict json_schema payload named quiz_extraction", () => {
    expect(QUIZ_EXTRACTION_SCHEMA.name).toBe("quiz_extraction");
    expect(QUIZ_EXTRACTION_SCHEMA.strict).toBe(true);
    expect(QUIZ_EXTRACTION_SCHEMA.schema.additionalProperties).toBe(false);
    expect(QUIZ_EXTRACTION_SCHEMA.schema.required).toEqual(["has_answer_key", "quiz_title", "questions"]);
  });
});
