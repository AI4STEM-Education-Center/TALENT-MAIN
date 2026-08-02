// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { parseQtiQuestionBank, validateParsedQuestionBank } from "./qti";

// A Canvas-style QTI 1.2 export covering single-select, multi-select (with a
// <not>-wrapped distractor that must be excluded from the correct set),
// metadata-driven multi-select, and two invalid items that become errors.
const SAMPLE_QTI = `<?xml version="1.0" encoding="UTF-8"?>
<questestinterop>
  <assessment ident="bank-123" title="Sample Bank">
    <section ident="root_section">

      <item ident="q1" title="Question One">
        <itemmetadata><qtimetadata>
          <qtimetadatafield>
            <fieldlabel>question_type</fieldlabel>
            <fieldentry>multiple_choice_question</fieldentry>
          </qtimetadatafield>
        </qtimetadata></itemmetadata>
        <presentation>
          <material><mattext>What is the capital of France?</mattext></material>
          <response_lid ident="response1" rcardinality="Single">
            <render_choice>
              <response_label ident="opt_a"><material><mattext>London</mattext></material></response_label>
              <response_label ident="opt_b"><material><mattext>Paris</mattext></material></response_label>
              <response_label ident="opt_c"><material><mattext>Berlin</mattext></material></response_label>
              <response_label ident="opt_d"><material><mattext>Madrid</mattext></material></response_label>
            </render_choice>
          </response_lid>
        </presentation>
        <resprocessing>
          <respcondition continue="No">
            <conditionvar><varequal respident="response1">opt_b</varequal></conditionvar>
            <displayfeedback feedbacktype="Response" linkrefid="correct_fb"/>
          </respcondition>
          <respcondition continue="Yes">
            <conditionvar><not><varequal respident="response1">opt_b</varequal></not></conditionvar>
            <displayfeedback feedbacktype="Response" linkrefid="general_incorrect_fb"/>
          </respcondition>
        </resprocessing>
        <itemfeedback ident="correct_fb"><flow_mat><material><mattext>Correct! Paris it is.</mattext></material></flow_mat></itemfeedback>
        <itemfeedback ident="general_incorrect_fb"><flow_mat><material><mattext>Not quite.</mattext></material></flow_mat></itemfeedback>
        <itemfeedback ident="general_fb"><flow_mat><material><mattext>Capitals matter.</mattext></material></flow_mat></itemfeedback>
      </item>

      <item ident="q2" title="Question Two">
        <presentation>
          <material><mattext>Select all prime numbers.</mattext></material>
          <response_lid ident="response1" rcardinality="Multiple">
            <render_choice>
              <response_label ident="opt_2"><material><mattext>2</mattext></material></response_label>
              <response_label ident="opt_3"><material><mattext>3</mattext></material></response_label>
              <response_label ident="opt_4"><material><mattext>4</mattext></material></response_label>
            </render_choice>
          </response_lid>
        </presentation>
        <resprocessing>
          <respcondition>
            <conditionvar><and>
              <varequal respident="response1">opt_2</varequal>
              <varequal respident="response1">opt_3</varequal>
              <not><varequal respident="response1">opt_4</varequal></not>
            </and></conditionvar>
          </respcondition>
        </resprocessing>
      </item>

      <item ident="q3">
        <itemmetadata><qtimetadata>
          <qtimetadatafield>
            <fieldlabel>question_type</fieldlabel>
            <fieldentry>multiple_answers_question</fieldentry>
          </qtimetadatafield>
        </qtimetadata></itemmetadata>
        <presentation>
          <material><mattext>Pick the mammal.</mattext></material>
          <response_lid ident="response1" rcardinality="Single">
            <render_choice>
              <response_label ident="o1"><material><mattext>Dog</mattext></material></response_label>
              <response_label ident="o2"><material><mattext>Trout</mattext></material></response_label>
            </render_choice>
          </response_lid>
        </presentation>
        <resprocessing>
          <respcondition><conditionvar><varequal respident="response1">o1</varequal></conditionvar></respcondition>
        </resprocessing>
      </item>

      <item ident="q4_broken">
        <presentation>
          <material><mattext>Broken: only one choice.</mattext></material>
          <response_lid ident="response1" rcardinality="Single">
            <render_choice>
              <response_label ident="x1"><material><mattext>Only one</mattext></material></response_label>
            </render_choice>
          </response_lid>
        </presentation>
        <resprocessing>
          <respcondition><conditionvar><varequal respident="response1">x1</varequal></conditionvar></respcondition>
        </resprocessing>
      </item>

      <item ident="q5_nocorrect">
        <presentation>
          <material><mattext>No correct answer here.</mattext></material>
          <response_lid ident="response1" rcardinality="Single">
            <render_choice>
              <response_label ident="y1"><material><mattext>A</mattext></material></response_label>
              <response_label ident="y2"><material><mattext>B</mattext></material></response_label>
            </render_choice>
          </response_lid>
        </presentation>
        <resprocessing></resprocessing>
      </item>

    </section>
  </assessment>
</questestinterop>`;

describe("parseQtiQuestionBank", () => {
  const bank = parseQtiQuestionBank(SAMPLE_QTI);

  it("reads bank id and title from the assessment", () => {
    expect(bank.bankId).toBe("bank-123");
    expect(bank.bankTitle).toBe("Sample Bank");
  });

  it("parses the three valid questions and records two errors", () => {
    expect(bank.questions).toHaveLength(3);
    expect(bank.errors).toHaveLength(2);
  });

  it("parses a single-select question with one correct option and feedback", () => {
    const q1 = bank.questions[0];
    expect(q1.sourceQuestionId).toBe("q1");
    expect(q1.title).toBe("Question One");
    expect(q1.text).toBe("What is the capital of France?");
    expect(q1.answerMode).toBe("SINGLE_SELECT");
    expect(q1.options).toHaveLength(4);
    expect(q1.options.filter((o) => o.isCorrect).map((o) => o.text)).toEqual(["Paris"]);
    expect(q1.feedbackCorrect).toBe("Correct! Paris it is.");
    expect(q1.feedbackIncorrect).toBe("Not quite.");
    expect(q1.feedbackGeneral).toBe("Capitals matter.");
  });

  it("infers MULTI_SELECT from rcardinality and excludes <not>-wrapped options", () => {
    const q2 = bank.questions[1];
    expect(q2.answerMode).toBe("MULTI_SELECT");
    const correct = q2.options.filter((o) => o.isCorrect).map((o) => o.text);
    expect(correct.sort()).toEqual(["2", "3"]); // "4" was under <not>
    expect(q2.options.find((o) => o.text === "4")?.isCorrect).toBe(false);
  });

  it("infers MULTI_SELECT from question_type metadata even with a single correct answer", () => {
    const q3 = bank.questions[2];
    expect(q3.answerMode).toBe("MULTI_SELECT");
    expect(q3.options.filter((o) => o.isCorrect).map((o) => o.text)).toEqual(["Dog"]);
  });

  it("flags an item with fewer than two options", () => {
    const err = bank.errors.find((e) => e.sourceQuestionId === "q4_broken");
    expect(err?.message).toMatch(/at least 2 answer choices/i);
  });

  it("flags an item with no correct answer", () => {
    const err = bank.errors.find((e) => e.sourceQuestionId === "q5_nocorrect");
    expect(err?.message).toMatch(/at least one answer choice must be correct/i);
  });
});

describe("parseQtiQuestionBank — HTML normalization", () => {
  it("flattens HTML paragraphs in question text", () => {
    const xml = `<questestinterop><assessment ident="b" title="t"><section>
      <item ident="h1"><presentation>
        <material><mattext texttype="text/html">&lt;p&gt;Line one&lt;/p&gt;&lt;p&gt;Line two&lt;/p&gt;</mattext></material>
        <response_lid ident="r" rcardinality="Single"><render_choice>
          <response_label ident="a"><material><mattext>A</mattext></material></response_label>
          <response_label ident="b"><material><mattext>B</mattext></material></response_label>
        </render_choice></response_lid>
      </presentation>
      <resprocessing><respcondition><conditionvar><varequal respident="r">a</varequal></conditionvar></respcondition></resprocessing>
      </item></section></assessment></questestinterop>`;
    const { questions } = parseQtiQuestionBank(xml);
    expect(questions[0].text).toContain("Line one");
    expect(questions[0].text).toContain("Line two");
    expect(questions[0].text).not.toContain("<p>");
  });
});

describe("parseQtiQuestionBank — fatal errors", () => {
  it("throws when there is no <assessment>", () => {
    expect(() => parseQtiQuestionBank("<questestinterop></questestinterop>")).toThrow(/assessment/i);
  });
});

describe("validateParsedQuestionBank", () => {
  const validPayload = {
    bankId: "b1",
    bankTitle: "Imported",
    questions: [
      {
        text: "2 + 2 = ?",
        answerMode: "SINGLE_SELECT",
        points: 1,
        options: [
          { text: "3", isCorrect: false },
          { text: "4", isCorrect: true },
        ],
      },
    ],
    errors: [{ index: 0, sourceQuestionId: "x", message: "skipped" }],
  };

  it("returns a normalized bank for a valid payload", () => {
    const result = validateParsedQuestionBank(validPayload);
    expect(result.bankTitle).toBe("Imported");
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].options).toHaveLength(2);
    expect(result.errors[0].message).toBe("skipped");
  });

  it("rejects a non-object payload", () => {
    expect(() => validateParsedQuestionBank([])).toThrow(/parsed question bank/i);
    expect(() => validateParsedQuestionBank(null)).toThrow(/parsed question bank/i);
  });

  it("rejects a payload without a questions array", () => {
    expect(() => validateParsedQuestionBank({})).toThrow(/questions array/i);
  });

  it("rejects a question missing text", () => {
    expect(() =>
      validateParsedQuestionBank({ questions: [{ answerMode: "SINGLE_SELECT", options: validPayload.questions[0].options }] })
    ).toThrow(/missing text/i);
  });

  it("rejects an invalid answer mode", () => {
    expect(() =>
      validateParsedQuestionBank({ questions: [{ text: "q", answerMode: "WHATEVER", options: validPayload.questions[0].options }] })
    ).toThrow(/invalid answer mode/i);
  });

  it("rejects a question with fewer than two options", () => {
    expect(() =>
      validateParsedQuestionBank({ questions: [{ text: "q", answerMode: "SINGLE_SELECT", options: [{ text: "only", isCorrect: true }] }] })
    ).toThrow(/at least 2 options/i);
  });

  it("rejects a question with no correct option", () => {
    expect(() =>
      validateParsedQuestionBank({
        questions: [{ text: "q", answerMode: "SINGLE_SELECT", options: [{ text: "a", isCorrect: false }, { text: "b", isCorrect: false }] }],
      })
    ).toThrow(/at least one correct option/i);
  });

  it("bounds question, option, and text counts before database work", () => {
    expect(() => validateParsedQuestionBank({ questions: Array(5_001).fill(validPayload.questions[0]) }))
      .toThrow(/5,000 questions/i);
    expect(() => validateParsedQuestionBank({
      questions: [{ ...validPayload.questions[0], options: Array(21).fill({ text: "x", isCorrect: true }) }],
    })).toThrow(/20 options/i);
    expect(() => validateParsedQuestionBank({
      questions: [{ ...validPayload.questions[0], text: "x".repeat(10_001) }],
    })).toThrow(/text is too long/i);
  });
});
