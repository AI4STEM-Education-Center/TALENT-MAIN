import { describe, it, expect } from "vitest";
import {
  normalizeSurveyQuestions,
  parseNumericScale,
  parseSurveyText,
  validateSurveyAnswers,
  normalizeExtractedSurvey,
  type SurveyQuestion,
} from "@/lib/survey";
import { SURVEY_TEMPLATES } from "@/lib/survey-templates";

const q = (overrides: Partial<SurveyQuestion>): SurveyQuestion => ({
  id: "q1",
  type: "single",
  text: "Pick one",
  help: "",
  options: ["A", "B"],
  otherLabel: "",
  required: true,
  ...overrides,
});

describe("normalizeSurveyQuestions", () => {
  it("drops junk, dedupes options and assigns unique ids", () => {
    const out = normalizeSurveyQuestions([
      null,
      { type: "single", text: "One", options: ["A", "a", "B", ""], id: "x" },
      { type: "single", text: "Two", options: ["A", "B"], id: "x" },
      { type: "bogus", text: "Three" },
      { type: "text", text: "" },
    ]);
    expect(out.map((o) => o.id)).toEqual(["x", "q2", "q3"]);
    expect(out[0].options).toEqual(["A", "B"]);
    expect(out[2].type).toBe("text");
  });

  it("degrades a choice question without enough options to short answer", () => {
    const [only] = normalizeSurveyQuestions([
      { type: "single", text: "Lonely", options: ["Only"] },
    ]);
    expect(only.type).toBe("text");
    expect(only.options).toEqual([]);
  });

  it("keeps a write-in option out of the listed options", () => {
    const [one] = normalizeSurveyQuestions([
      {
        type: "single",
        text: "Who?",
        options: ["A", "Other"],
        otherLabel: "Other",
      },
    ]);
    expect(one.options).toEqual(["A"]);
    expect(one.otherLabel).toBe("Other");
  });

  it("never marks a section required", () => {
    const [s] = normalizeSurveyQuestions([
      { type: "section", text: "Part 1", required: true },
    ]);
    expect(s.required).toBe(false);
  });
});

describe("validateSurveyAnswers", () => {
  it("requires required questions and reports which one", () => {
    const result = validateSurveyAnswers([q({})], {});
    expect(result).toMatchObject({ ok: false, questionId: "q1" });
  });

  it("rejects a choice that is not an option", () => {
    const result = validateSurveyAnswers([q({})], { q1: "C" });
    expect(result.ok).toBe(false);
  });

  it("accepts a write-in answer and drops unknown keys", () => {
    const result = validateSurveyAnswers([q({ otherLabel: "Other" })], {
      q1: "Other: my own words",
      junk: "x",
    });
    expect(result).toEqual({
      ok: true,
      answers: { q1: "Other: my own words" },
    });
  });

  it("filters multi-select answers to real options", () => {
    const result = validateSurveyAnswers(
      [q({ type: "multi", options: ["A", "B", "C"] })],
      { q1: ["A", "Z", "A", "C"] },
    );
    expect(result).toEqual({ ok: true, answers: { q1: ["A", "C"] } });
  });

  it("lets optional questions be skipped and ignores sections", () => {
    const result = validateSurveyAnswers(
      [
        q({ id: "s1", type: "section", options: [], required: false }),
        q({ id: "t1", type: "textarea", options: [], required: false }),
      ],
      {},
    );
    expect(result).toEqual({ ok: true, answers: {} });
  });
});

describe("parseNumericScale", () => {
  it("reads both '=' and '-' separated scales", () => {
    expect(
      parseNumericScale(
        "1 = Strongly Disagree, 2 = Disagree, 3 = Neutral, 4 = Agree, 5 = Strongly Agree",
      ),
    ).toEqual([
      "1 - Strongly Disagree",
      "2 - Disagree",
      "3 - Neutral",
      "4 - Agree",
      "5 - Strongly Agree",
    ]);
    expect(
      parseNumericScale(
        "(1-A lot less effort, 2-Slightly less effort, 3- About the same)",
      ),
    ).toEqual([
      "1 - A lot less effort",
      "2 - Slightly less effort",
      "3 - About the same",
    ]);
  });

  it("ignores lines that are not scales", () => {
    expect(parseNumericScale("□ under 1 □ 1-5 □ 5-10 □ 10+")).toBeNull();
  });
});

describe("parseSurveyText", () => {
  it("drafts a checkbox survey with sections, inline options and write-ins", () => {
    const text = [
      "Student Usability Survey – Pre Session Survey",
      "Welcome! Thank you for taking part.",
      "Demographic Information",
      "1. Which best describes you?",
      "☐ Female",
      "☐ Male",
      "☐ Prefer to self-describe: ______",
      "2. How frequently do you use AI tools?",
      "☐ Never ☐ Once or twice ☐ A few times ☐ Many times",
      "3. If you need help, who do you ask first?",
      "☐ Teachers",
      "☐ Relative",
      "Other ______",
    ].join("\n");
    const parsed = parseSurveyText(text);
    expect(parsed.title).toBe("Student Usability Survey – Pre Session Survey");
    expect(parsed.description).toBe("Welcome! Thank you for taking part.");
    const [section, q1, q2, q3] = parsed.questions;
    expect(section).toMatchObject({
      type: "section",
      text: "Demographic Information",
    });
    expect(q1).toMatchObject({
      type: "single",
      options: ["Female", "Male"],
      otherLabel: "Prefer to self-describe",
    });
    expect(q2.options).toEqual([
      "Never",
      "Once or twice",
      "A few times",
      "Many times",
    ]);
    expect(q3).toMatchObject({
      options: ["Teachers", "Relative"],
      otherLabel: "Other",
    });
  });

  it("applies a declared scale to statements and not to open questions", () => {
    const text = [
      "Student Post-Implementation Survey",
      "1 = Strongly Disagree, 2 = Disagree, 3 = Neutral, 4 = Agree, 5 = Strongly Agree",
      "Usability",
      "1. AI4Talent was easy to use.",
      "2. I found the responses",
      "helpful.",
      "Suggestions for Improvement",
      "3. What features did you find most helpful?",
      "___________",
    ].join("\n");
    const qs = parseSurveyText(text).questions;
    expect(qs.map((x) => x.type)).toEqual([
      "section",
      "likert",
      "likert",
      "section",
      "textarea",
    ]);
    expect(qs[2].text).toBe("I found the responses helpful.");
    expect(qs[1].options).toHaveLength(5);
  });

  it("gives a prompt its own inline scale without changing the shared one", () => {
    const text = [
      "Instructor Post-Implementation Survey",
      "Part 1: Usability",
      "(5-point Likert scale: 1-Strongly Disagree, 2-Disagree, 3- Neutral, 4 -Agree, 5-Strongly",
      "Agree)",
      "1. I enjoyed it.",
      "2. The effort compared to similar platforms was: (5-point",
      "Likert scale: 1-A lot less effort, 2-Slightly less effort, 3- About the same, 4 –",
      "Slightly more effort, 5-At lot more effort)",
      "3. It ran smoothly.",
    ].join("\n");
    const qs = parseSurveyText(text).questions.filter(
      (x) => x.type !== "section",
    );
    expect(qs[0].options.at(-1)).toBe("5 - Strongly Agree");
    expect(qs[1].options[0]).toBe("1 - A lot less effort");
    expect(qs[1].text).not.toMatch(/Likert/);
    expect(qs[2].options[0]).toBe("1 - Strongly Disagree");
  });
});

describe("normalizeExtractedSurvey", () => {
  it("maps the model's other_label onto otherLabel", () => {
    const out = normalizeExtractedSurvey({
      title: "T",
      description: "",
      questions: [
        {
          type: "single",
          text: "Who?",
          help: "",
          options: ["A", "B"],
          other_label: "Other",
          required: true,
        },
      ],
    });
    expect(out.questions[0].otherLabel).toBe("Other");
  });
});

describe("built-in survey templates", () => {
  it.each(SURVEY_TEMPLATES.map((t) => [t.key, t] as const))(
    "%s is already normalized",
    (_key, template) => {
      expect(normalizeSurveyQuestions(template.questions)).toEqual(
        template.questions,
      );
      expect(template.questions.some((x) => x.type !== "section")).toBe(true);
    },
  );

  it("covers each survey type and audience once", () => {
    const keys = SURVEY_TEMPLATES.map((t) => `${t.kind}-${t.role}`).sort();
    expect(keys).toEqual([
      "POST-STUDENT",
      "POST-TEACHER",
      "PRE-STUDENT",
      "PRE-TEACHER",
    ]);
  });
});
