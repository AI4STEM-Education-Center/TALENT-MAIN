import { describe, it, expect } from "vitest";
import {
  QUIZ_EXTRACTION_SCHEMA,
  QUIZ_ANSWER_KEY_SCHEMA,
  QUIZ_LOCALIZATION_SCHEMA,
  buildExtractionPrompt,
  buildAnswerKeyPrompt,
  buildLocalizationPrompt,
  summarizeQuestionsForAnswerKey,
  optionLetter,
  letterToOptionIndex,
  validateExtractedQuiz,
  validateAnswerKeyResult,
  applyAnswerKey,
  normalizeStructure,
  finalizeAnswers,
  normalizeExtractedQuiz,
  validateCommitQuestions,
  mapStagedToQuestionData,
  parseStagedQuestions,
  buildTargetId,
  collectLocalizationTargets,
  needsLocalization,
  groupTargetsByPage,
  validateLocalizationResult,
  mergeLocalizedBoxes,
  LATEX_INLINE_DELIMITER,
  type AnswerKeyResult,
  type ExtractedQuiz,
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

  it("tells the model NOT to determine answers in this pass", () => {
    expect(prompt).toMatch(/do not decide which option is correct/i);
    expect(prompt).toMatch(/leave every is_correct null/i);
  });

  it("explains shared / unified labeled option banks reused across numbered items", () => {
    expect(prompt).toMatch(/shared/i);
    expect(prompt).toMatch(/matching \/ classification/i);
    expect(prompt).toMatch(/full shared option list/i);
  });

  it("tells the model to strip option labels and rely on position", () => {
    expect(prompt).toMatch(/strip the leading label/i);
    expect(prompt).toMatch(/labeled/i);
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

// ─── optionLetter / letterToOptionIndex ─────────────────────────────────────────

describe("optionLetter / letterToOptionIndex", () => {
  it("maps 0-based indices to spreadsheet-style letters", () => {
    expect(optionLetter(0)).toBe("A");
    expect(optionLetter(3)).toBe("D");
    expect(optionLetter(25)).toBe("Z");
    expect(optionLetter(26)).toBe("AA");
  });

  it("maps letters back to indices, case-insensitively", () => {
    expect(letterToOptionIndex("A")).toBe(0);
    expect(letterToOptionIndex("d")).toBe(3);
    expect(letterToOptionIndex("Z")).toBe(25);
    expect(letterToOptionIndex("AA")).toBe(26);
  });

  it("returns null for non A..Z labels", () => {
    expect(letterToOptionIndex("1")).toBeNull();
    expect(letterToOptionIndex("")).toBeNull();
    expect(letterToOptionIndex("A1")).toBeNull();
  });

  it("round-trips index → letter → index", () => {
    for (let i = 0; i < 60; i += 1) {
      expect(letterToOptionIndex(optionLetter(i))).toBe(i);
    }
  });
});

// ─── summarizeQuestionsForAnswerKey ─────────────────────────────────────────────

describe("summarizeQuestionsForAnswerKey", () => {
  it("enumerates each question with lettered options and marks numeric questions", () => {
    const summary = summarizeQuestionsForAnswerKey([
      staged({ text: "Marital status", options: [{ text: "Nominal", isCorrect: null }, { text: "Ordinal", isCorrect: null }] }),
      staged({ type: "NUMERIC", text: "Family income in dollars", options: [] }),
    ]);
    expect(summary).toContain("[0] Marital status");
    expect(summary).toContain("A. Nominal");
    expect(summary).toContain("B. Ordinal");
    expect(summary).toContain("[1] Family income in dollars");
    expect(summary).toMatch(/numeric/i);
  });

  it("renders an image option as [image: alt]", () => {
    const summary = summarizeQuestionsForAnswerKey([
      staged({ options: [{ text: "", isCorrect: null, isImage: true, imageAlt: "rising graph" }, { text: "plain", isCorrect: null }] }),
    ]);
    expect(summary).toContain("A. [image: rising graph]");
    expect(summary).toContain("B. plain");
  });
});

// ─── buildAnswerKeyPrompt ────────────────────────────────────────────────────────

describe("buildAnswerKeyPrompt", () => {
  const questions = [
    staged({ text: "Marital status", options: [{ text: "Nominal", isCorrect: null }, { text: "Ordinal", isCorrect: null }] }),
  ];
  const prompt = buildAnswerKeyPrompt(2, questions);

  it("mentions the page count", () => {
    expect(prompt).toContain("2 page images");
  });

  it("lists all three answer-source families", () => {
    expect(prompt).toMatch(/inline/i);
    expect(prompt).toMatch(/consolidated key block/i);
    expect(prompt).toMatch(/green/i);
  });

  it("instructs the model to reconcile disagreeing sources", () => {
    expect(prompt).toMatch(/reconcil/i);
    expect(prompt).toMatch(/conflict/i);
  });

  it("forbids solving or guessing the answer", () => {
    expect(prompt).toMatch(/never solve the question yourself or guess/i);
  });

  it("embeds the enumerated questions", () => {
    expect(prompt).toContain("[0] Marital status");
    expect(prompt).toContain("A. Nominal");
  });

  it("is deterministic for the same inputs", () => {
    expect(buildAnswerKeyPrompt(2, questions)).toBe(buildAnswerKeyPrompt(2, questions));
  });
});

// ─── QUIZ_ANSWER_KEY_SCHEMA ─────────────────────────────────────────────────────

describe("QUIZ_ANSWER_KEY_SCHEMA", () => {
  it("is a strict json_schema payload named quiz_answer_key", () => {
    expect(QUIZ_ANSWER_KEY_SCHEMA.name).toBe("quiz_answer_key");
    expect(QUIZ_ANSWER_KEY_SCHEMA.strict).toBe(true);
    expect(QUIZ_ANSWER_KEY_SCHEMA.schema.required).toEqual(["has_answer_key", "answers"]);
    expect(QUIZ_ANSWER_KEY_SCHEMA.schema.additionalProperties).toBe(false);
  });
});

// ─── validateAnswerKeyResult ─────────────────────────────────────────────────────

function rawAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question_index: 0,
    correct_labels: ["A"],
    numeric_answer: null,
    source: "inline",
    confidence: 0.9,
    conflict: false,
    note: null,
    ...overrides,
  };
}

describe("validateAnswerKeyResult", () => {
  it("validates a well-formed payload", () => {
    const result = validateAnswerKeyResult({
      has_answer_key: true,
      answers: [rawAnswer(), rawAnswer({ question_index: 1, correct_labels: [], numeric_answer: 3.21, source: "key_block" })],
    });
    expect(result.hasAnswerKey).toBe(true);
    expect(result.answers[0].correctLabels).toEqual(["A"]);
    expect(result.answers[1].numericAnswer).toBe(3.21);
    expect(result.answers[1].source).toBe("key_block");
  });

  it("rejects a non-object payload / bad has_answer_key / non-array answers", () => {
    expect(() => validateAnswerKeyResult(null)).toThrow(/must be an object/i);
    expect(() => validateAnswerKeyResult({ has_answer_key: "yes", answers: [] })).toThrow(/has_answer_key/i);
    expect(() => validateAnswerKeyResult({ has_answer_key: true, answers: {} })).toThrow(/answers must be an array/i);
  });

  it("rejects a negative / non-integer question_index", () => {
    expect(() =>
      validateAnswerKeyResult({ has_answer_key: true, answers: [rawAnswer({ question_index: -1 })] })
    ).toThrow(/question_index/i);
  });

  it("degrades an unknown source to none, clamps confidence, and drops empty labels", () => {
    const result = validateAnswerKeyResult({
      has_answer_key: true,
      answers: [rawAnswer({ source: "guessed", confidence: 5, correct_labels: ["A", "", "  ", "C"] })],
    });
    expect(result.answers[0].source).toBe("none");
    expect(result.answers[0].confidence).toBe(1);
    expect(result.answers[0].correctLabels).toEqual(["A", "C"]);
  });
});

// ─── applyAnswerKey ──────────────────────────────────────────────────────────────

function quizFrom(questions: StagedQuestion[], hasAnswerKey = false): ExtractedQuiz {
  return { hasAnswerKey, quizTitle: null, questions, warnings: [] };
}

function answerKey(answers: AnswerKeyResult["answers"], hasAnswerKey = true): AnswerKeyResult {
  return { hasAnswerKey, answers };
}

describe("applyAnswerKey", () => {
  const abcd = () => [
    { text: "Nominal", isCorrect: null },
    { text: "Ordinal", isCorrect: null },
    { text: "Interval", isCorrect: null },
    { text: "Ratio", isCorrect: null },
  ];

  it("maps a correct letter onto the option position", () => {
    const quiz = quizFrom([staged({ text: "Marital status", options: abcd() })]);
    const applied = applyAnswerKey(quiz, answerKey([{ questionIndex: 0, correctLabels: ["A"], numericAnswer: null, source: "inline", confidence: 1, conflict: false, note: null }]));
    expect(applied.hasAnswerKey).toBe(true);
    expect(applied.questions[0].options.map((o) => o.isCorrect)).toEqual([true, false, false, false]);
  });

  it("handles a whole shared-bank quiz (the Week 5 keys A B C B D…)", () => {
    const stems = ["Marital status", "Achievement rank", "Raw score", "Educational level", "Years of education"];
    const letters = ["A", "B", "C", "B", "D"];
    const quiz = quizFrom(stems.map((text) => staged({ text, options: abcd() })));
    const applied = applyAnswerKey(
      quiz,
      answerKey(
        letters.map((l, i) => ({ questionIndex: i, correctLabels: [l], numericAnswer: null, source: "mixed" as const, confidence: 1, conflict: false, note: null }))
      )
    );
    applied.questions.forEach((q, i) => {
      const expectedIdx = letterToOptionIndex(letters[i])!;
      expect(q.options.findIndex((o) => o.isCorrect === true)).toBe(expectedIdx);
      expect(q.options.filter((o) => o.isCorrect === true)).toHaveLength(1);
    });
  });

  it("copies a numeric answer without touching options", () => {
    const quiz = quizFrom([staged({ type: "NUMERIC", options: [] })]);
    const applied = applyAnswerKey(quiz, answerKey([{ questionIndex: 0, correctLabels: [], numericAnswer: 3.21, source: "key_block", confidence: 1, conflict: false, note: null }]));
    expect(applied.questions[0].numericAnswer).toBe(3.21);
  });

  it("flags a conflict for review", () => {
    const quiz = quizFrom([staged({ options: abcd() })]);
    const applied = applyAnswerKey(quiz, answerKey([{ questionIndex: 0, correctLabels: ["A"], numericAnswer: null, source: "mixed", confidence: 0.5, conflict: true, note: "inline said A, key said B" }]));
    expect(applied.questions[0].needsReview).toBe(true);
    expect(applied.questions[0].reviewNote).toMatch(/disagreed/i);
  });

  it("flags an out-of-range answer letter for review", () => {
    const quiz = quizFrom([staged({ options: [{ text: "x", isCorrect: null }, { text: "y", isCorrect: null }] })]);
    const applied = applyAnswerKey(quiz, answerKey([{ questionIndex: 0, correctLabels: ["Z"], numericAnswer: null, source: "inline", confidence: 1, conflict: false, note: null }]));
    expect(applied.questions[0].needsReview).toBe(true);
    expect(applied.questions[0].reviewNote).toMatch(/did not match an option/i);
    expect(applied.questions[0].options.every((o) => o.isCorrect === false)).toBe(true);
  });

  it("leaves correctness null when the question has no key entry", () => {
    const quiz = quizFrom([staged({ options: abcd() }), staged({ options: abcd() })]);
    const applied = applyAnswerKey(quiz, answerKey([{ questionIndex: 0, correctLabels: ["A"], numericAnswer: null, source: "inline", confidence: 1, conflict: false, note: null }]));
    expect(applied.questions[1].options.every((o) => o.isCorrect === null)).toBe(true);
  });

  it("leaves everything null and hasAnswerKey false when there is no key", () => {
    const quiz = quizFrom([staged({ options: abcd() })]);
    const applied = applyAnswerKey(quiz, answerKey([{ questionIndex: 0, correctLabels: ["A"], numericAnswer: null, source: "none", confidence: 0, conflict: false, note: null }], false));
    expect(applied.hasAnswerKey).toBe(false);
    expect(applied.questions[0].options.every((o) => o.isCorrect === null)).toBe(true);
  });

  it("does not mutate a deep-frozen input", () => {
    const quiz = quizFrom([staged({ options: abcd() })]);
    const deepFreeze = (obj: unknown): void => {
      if (obj && typeof obj === "object") {
        Object.values(obj).forEach(deepFreeze);
        Object.freeze(obj);
      }
    };
    deepFreeze(quiz);
    expect(() =>
      applyAnswerKey(quiz, answerKey([{ questionIndex: 0, correctLabels: ["A"], numericAnswer: null, source: "inline", confidence: 1, conflict: false, note: null }]))
    ).not.toThrow();
    expect(quiz.questions[0].options.every((o) => o.isCorrect === null)).toBe(true);
  });
});

// ─── normalizeStructure / finalizeAnswers split ─────────────────────────────────

describe("normalizeStructure", () => {
  it("does NOT null correctness or add a no-key note (leaves answers to a later pass)", () => {
    const quiz = quizFrom([staged({ options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: false }] })], false);
    const result = normalizeStructure(quiz);
    expect(result.questions[0].options.map((o) => o.isCorrect)).toEqual([true, false]);
    expect(result.questions[0].reviewNote ?? "").not.toMatch(/no answer key/i);
  });

  it("still strips artifact options and forces figure review", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({
        questions: [
          rawQuestion({ options: [rawOption("3", false), rawOption("4", false), rawOption("◄▬►", false)], has_figure: true, figure_page: 1, figure_bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } }),
        ],
      })
    );
    const result = normalizeStructure(quiz);
    expect(result.questions[0].options.map((o) => o.text)).toEqual(["3", "4"]);
    expect(result.questions[0].needsReview).toBe(true);
    expect(result.questions[0].reviewNote).toMatch(/figure crop/i);
  });
});

describe("finalizeAnswers", () => {
  it("converts an over-marked multiple_choice to multi-select", () => {
    const quiz = quizFrom([staged({ options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: true }, { text: "c", isCorrect: false }] })], true);
    const result = finalizeAnswers(quiz);
    expect(result.questions[0].type).toBe("MULTI_SELECT");
  });

  it("nulls everything and reviews all when there is no key", () => {
    const quiz = quizFrom([staged({ options: [{ text: "a", isCorrect: true }, { text: "b", isCorrect: false }] })], false);
    const result = finalizeAnswers(quiz);
    expect(result.questions[0].options.every((o) => o.isCorrect === null)).toBe(true);
    expect(result.questions[0].needsReview).toBe(true);
    expect(result.questions[0].reviewNote).toMatch(/no answer key/i);
  });
});

describe("structure → answer key → finalize (shared-bank end to end)", () => {
  it("resolves a matching-style quiz with a consolidated key into fully answered questions", () => {
    // Pass 1 produced 3 questions all sharing the A/B/C/D bank, no answers yet.
    const structured = normalizeStructure(
      quizFrom([
        staged({ text: "Marital status", options: [{ text: "Nominal", isCorrect: null }, { text: "Ordinal", isCorrect: null }, { text: "Interval", isCorrect: null }, { text: "Ratio", isCorrect: null }] }),
        staged({ text: "Achievement rank", options: [{ text: "Nominal", isCorrect: null }, { text: "Ordinal", isCorrect: null }, { text: "Interval", isCorrect: null }, { text: "Ratio", isCorrect: null }] }),
        staged({ text: "Raw score", options: [{ text: "Nominal", isCorrect: null }, { text: "Ordinal", isCorrect: null }, { text: "Interval", isCorrect: null }, { text: "Ratio", isCorrect: null }] }),
      ])
    );
    // Pass 2 read "Keys: A B C" from the bottom of the page.
    const withKey = applyAnswerKey(
      structured,
      answerKey(["A", "B", "C"].map((l, i) => ({ questionIndex: i, correctLabels: [l], numericAnswer: null, source: "key_block" as const, confidence: 1, conflict: false, note: null })))
    );
    const final = finalizeAnswers(withKey);
    expect(final.hasAnswerKey).toBe(true);
    expect(final.questions.map((q) => q.options.findIndex((o) => o.isCorrect === true))).toEqual([0, 1, 2]);
    expect(final.questions.every((q) => q.options.filter((o) => o.isCorrect === true).length === 1)).toBe(true);
    // No spurious "no answer key" / "not marked" review flags.
    expect(final.questions.some((q) => /no answer key|no correct option/i.test(q.reviewNote ?? ""))).toBe(false);
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

// ─── Image answer-choices: validate / normalize / commit / map ──────────────────

function rawImageOption(alt: string, isCorrect: boolean | null, page = 1): Record<string, unknown> {
  return { text: "", is_correct: isCorrect, is_image: true, image_bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, image_page: page, image_alt: alt };
}

describe("image answer-choices", () => {
  it("validates an image option and keeps its bbox / page / alt", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({ questions: [rawQuestion({ options: [rawImageOption("graph A", true), rawImageOption("graph B", false)] })] })
    );
    const opt = quiz.questions[0].options[0];
    expect(opt.isImage).toBe(true);
    expect(opt.imageBbox).toEqual({ x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
    expect(opt.imagePage).toBe(1);
    expect(opt.imageAlt).toBe("graph A");
  });

  it("keeps an empty-text image option through normalize (not stripped as junk) and forces review", () => {
    const quiz = validateExtractedQuiz(
      rawQuizPayload({ questions: [rawQuestion({ options: [rawImageOption("A", true), rawImageOption("B", false)] })] })
    );
    const result = normalizeExtractedQuiz(quiz);
    expect(result.questions[0].options).toHaveLength(2);
    expect(result.questions[0].options.every((o) => o.isImage === true)).toBe(true);
    expect(result.questions[0].needsReview).toBe(true);
    expect(result.questions[0].reviewNote).toMatch(/image-choice crops/i);
  });
});

describe("validateCommitQuestions — image options", () => {
  it("accepts an image option with empty text but an uploaded key", () => {
    const result = validateCommitQuestions([
      commitQuestion({
        options: [
          { text: "", isCorrect: true, isImage: true, imageStorageKey: "k/figures/option-0-0.png", imageAlt: "A" },
          { text: "", isCorrect: false, isImage: true, imageStorageKey: "k/figures/option-0-1.png", imageAlt: "B" },
        ],
      }),
    ]);
    expect(result[0].options[0].isImage).toBe(true);
    expect(result[0].options[0].imageStorageKey).toBe("k/figures/option-0-0.png");
  });

  it("rejects an image option without an uploaded key", () => {
    expect(() =>
      validateCommitQuestions([
        commitQuestion({
          options: [
            { text: "", isCorrect: true, isImage: true, imageStorageKey: null },
            { text: "b", isCorrect: false },
          ],
        }),
      ])
    ).toThrow(/image option requires an uploaded image/i);
  });

  it("still rejects a text option with empty text", () => {
    expect(() =>
      validateCommitQuestions([commitQuestion({ options: [{ text: "", isCorrect: true }, { text: "b", isCorrect: false }] })])
    ).toThrow(/text is required/i);
  });

  it("rejects image options on TRUE_FALSE", () => {
    expect(() =>
      validateCommitQuestions([
        commitQuestion({
          type: "TRUE_FALSE",
          options: [
            { text: "", isCorrect: true, isImage: true, imageStorageKey: "k/figures/option-0-0.png" },
            { text: "False", isCorrect: false },
          ],
        }),
      ])
    ).toThrow(/TRUE_FALSE options cannot be images/i);
  });

  it("rejects duplicate image options (same key)", () => {
    expect(() =>
      validateCommitQuestions([
        commitQuestion({
          options: [
            { text: "", isCorrect: true, isImage: true, imageStorageKey: "k/figures/dup.png" },
            { text: "", isCorrect: false, isImage: true, imageStorageKey: "k/figures/dup.png" },
          ],
        }),
      ])
    ).toThrow(/options must be distinct/i);
  });
});

describe("mapStagedToQuestionData — image options", () => {
  it("emits image fields only for image options", () => {
    const data = mapStagedToQuestionData(
      staged({
        options: [
          { text: "", isCorrect: true, isImage: true, imageStorageKey: "k/figures/option-0-0.png", imageAlt: "A" },
          { text: "plain", isCorrect: false },
        ],
      }),
      CTX
    );
    expect(data.options.create[0]).toEqual({
      text: "",
      isCorrect: true,
      imageStorageKey: "k/figures/option-0-0.png",
      imageBucket: "bucket-1",
      imageAlt: "A",
    });
    expect(data.options.create[1]).toEqual({ text: "plain", isCorrect: false });
  });
});

// ─── Pass-2 localization helpers ─────────────────────────────────────────────────

const quizOf = (questions: StagedQuestion[]): ExtractedQuiz => ({
  hasAnswerKey: true,
  quizTitle: null,
  questions,
  warnings: [],
});

function imageOptionsQuestion(): StagedQuestion {
  return staged({
    sourcePage: 1,
    options: [
      { text: "", isCorrect: true, isImage: true, imageBbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, imagePage: 1, imageAlt: "A" },
      { text: "", isCorrect: false, isImage: true, imageBbox: { x: 0.4, y: 0.1, w: 0.2, h: 0.2 }, imagePage: 1, imageAlt: "B" },
    ],
  });
}

describe("buildTargetId", () => {
  it("formats figure and option ids deterministically", () => {
    expect(buildTargetId(3, "figure", null)).toBe("q3.figure");
    expect(buildTargetId(3, "option", 2)).toBe("q3.opt2");
  });
});

describe("collectLocalizationTargets / needsLocalization", () => {
  it("returns nothing for a text-only quiz", () => {
    const quiz = quizOf([staged()]);
    expect(collectLocalizationTargets(quiz)).toEqual([]);
    expect(needsLocalization(quiz)).toBe(false);
  });

  it("collects the figure then each image option in order", () => {
    const quiz = quizOf([
      staged({ hasFigure: true, figurePage: 2, figureBbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, figureCaption: "diagram", sourcePage: 2,
        options: [{ text: "", isCorrect: true, isImage: true, imageBbox: { x: 0.1, y: 0.5, w: 0.2, h: 0.2 }, imagePage: 2, imageAlt: "A" }] }),
    ]);
    const targets = collectLocalizationTargets(quiz);
    expect(targets.map((t) => t.targetId)).toEqual(["q0.figure", "q0.opt0"]);
    expect(targets[0].kind).toBe("figure");
    expect(targets[0].page).toBe(2);
    expect(needsLocalization(quiz)).toBe(true);
  });

  it("resolves an option page to the source page when image_page is null", () => {
    const quiz = quizOf([
      staged({ sourcePage: 3, options: [
        { text: "", isCorrect: true, isImage: true, imageBbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, imageAlt: "A" },
        { text: "x", isCorrect: false },
      ] }),
    ]);
    const targets = collectLocalizationTargets(quiz);
    expect(targets).toHaveLength(1);
    expect(targets[0].page).toBe(3);
  });
});

describe("groupTargetsByPage", () => {
  it("groups targets by their page", () => {
    const quiz = quizOf([
      staged({ hasFigure: true, figurePage: 2, figureBbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, figureCaption: "d", sourcePage: 2 }),
      imageOptionsQuestion(),
    ]);
    const byPage = groupTargetsByPage(collectLocalizationTargets(quiz));
    expect(byPage.get(2)?.map((t) => t.targetId)).toEqual(["q0.figure"]);
    expect(byPage.get(1)?.map((t) => t.targetId)).toEqual(["q1.opt0", "q1.opt1"]);
  });
});

describe("buildLocalizationPrompt", () => {
  const targets = collectLocalizationTargets(quizOf([imageOptionsQuestion()]));
  const prompt = buildLocalizationPrompt(1, targets);

  it("names the page and lists every target id in order", () => {
    expect(prompt).toContain("page 1");
    expect(prompt.indexOf("q0.opt0")).toBeGreaterThan(-1);
    expect(prompt.indexOf("q0.opt0")).toBeLessThan(prompt.indexOf("q0.opt1"));
  });
  it("asks for tight, non-overlapping boxes", () => {
    expect(prompt).toMatch(/tight/i);
    expect(prompt).toMatch(/overlap/i);
  });
  it("is deterministic", () => {
    expect(buildLocalizationPrompt(1, targets)).toBe(buildLocalizationPrompt(1, targets));
  });
});

describe("validateLocalizationResult", () => {
  const known = new Set(["q0.figure", "q0.opt0"]);

  it("keeps found boxes with known ids and clamps the bbox", () => {
    const out = validateLocalizationResult(
      { boxes: [{ target_id: "q0.opt0", found: true, bbox: { x: -0.1, y: 0.2, w: 0.3, h: 0.2 } }] },
      known
    );
    expect(out).toEqual([{ targetId: "q0.opt0", bbox: { x: 0, y: 0.2, w: 0.3, h: 0.2 } }]);
  });

  it("drops unknown ids, found:false and malformed bboxes, and dedupes", () => {
    const out = validateLocalizationResult(
      {
        boxes: [
          { target_id: "nope", found: true, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
          { target_id: "q0.figure", found: false, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
          { target_id: "q0.opt0", found: true, bbox: { x: 0.1, y: 0.1, w: "bad", h: 0.2 } },
          { target_id: "q0.opt0", found: true, bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
          { target_id: "q0.opt0", found: true, bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
        ],
      },
      known
    );
    expect(out).toEqual([{ targetId: "q0.opt0", bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }]);
  });

  it("returns [] for junk input", () => {
    expect(validateLocalizationResult(null, known)).toEqual([]);
    expect(validateLocalizationResult({}, known)).toEqual([]);
  });
});

describe("mergeLocalizedBoxes", () => {
  it("tightens an option box from pass 2 and keeps the other option's coarse box", () => {
    const merged = mergeLocalizedBoxes(quizOf([imageOptionsQuestion()]), [
      { targetId: "q0.opt0", bbox: { x: 0.11, y: 0.12, w: 0.13, h: 0.14 } },
    ]);
    expect(merged.questions[0].options[0].imageBbox).toEqual({ x: 0.11, y: 0.12, w: 0.13, h: 0.14 });
    expect(merged.questions[0].options[1].imageBbox).toEqual({ x: 0.4, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("forces needsReview when a figure has neither a tight nor a coarse box", () => {
    const merged = mergeLocalizedBoxes(
      quizOf([staged({ hasFigure: true, figurePage: 1, figureBbox: null, figureCaption: "x" })]),
      []
    );
    expect(merged.questions[0].needsReview).toBe(true);
    expect(merged.questions[0].reviewNote).toMatch(/could not locate the figure/i);
  });

  it("does not mutate a deep-frozen input", () => {
    const quiz = quizOf([imageOptionsQuestion()]);
    const deepFreeze = (obj: unknown): void => {
      if (obj && typeof obj === "object") {
        Object.values(obj).forEach(deepFreeze);
        Object.freeze(obj);
      }
    };
    deepFreeze(quiz);
    expect(() =>
      mergeLocalizedBoxes(quiz, [{ targetId: "q0.opt0", bbox: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } }])
    ).not.toThrow();
    expect(quiz.questions[0].options[0].imageBbox).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });
});

describe("QUIZ_LOCALIZATION_SCHEMA", () => {
  it("is a strict json_schema payload named quiz_localization", () => {
    expect(QUIZ_LOCALIZATION_SCHEMA.name).toBe("quiz_localization");
    expect(QUIZ_LOCALIZATION_SCHEMA.strict).toBe(true);
    expect(QUIZ_LOCALIZATION_SCHEMA.schema.required).toEqual(["boxes"]);
  });
});
