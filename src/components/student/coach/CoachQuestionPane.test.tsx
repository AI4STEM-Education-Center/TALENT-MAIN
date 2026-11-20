// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CoachQuestionView } from "@/lib/assistant/coach-types";
import { CoachQuestionPane } from "./CoachQuestionPane";

const option = (label: string, text: string, selected = false) => ({
  label,
  text,
  imageUrl: null,
  imageAlt: null,
  selected,
});

const base: CoachQuestionView = {
  questionNumber: 2,
  quizName: "Forces",
  answerMode: "SINGLE_SELECT",
  text: "Which force keeps the Moon in orbit?",
  figureUrl: null,
  figureAlt: null,
  options: [
    option("A", "Friction"),
    option("B", "Gravity"),
    option("C", "Magnetism", true),
    option("D", "Tension"),
  ],
  response: {
    kind: "choices",
    choices: [{ text: "Magnetism", imageUrl: null, imageAlt: null }],
  },
  review: null,
};

function render(question: CoachQuestionView) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <CoachQuestionPane question={question} />,
  );
  return host;
}

const rows = (host: HTMLElement) => [...host.querySelectorAll("li")];

describe("CoachQuestionPane", () => {
  it("shows every option A–D and the student's choice without revealing the key while a retake is possible", () => {
    const host = render(base);
    const items = rows(host);
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Friction"),
      expect.stringContaining("Gravity"),
      expect.stringContaining("Magnetism"),
      expect.stringContaining("Tension"),
    ]);
    expect(
      items.map((li) => li.querySelector("[aria-hidden]")?.textContent),
    ).toEqual(["A", "B", "C", "D"]);
    expect(items[2].textContent).toContain("Your answer");
    expect(host.textContent).not.toMatch(/correct/i);
    expect(items[1].className).not.toContain("green");
    expect(host.textContent).not.toContain("No answer selected");
  });

  it("flags an unanswered choice question but still lists all options", () => {
    const host = render({
      ...base,
      options: base.options.map((o) => ({ ...o, selected: false })),
      response: { kind: "choices", choices: [] },
    });
    expect(rows(host)).toHaveLength(4);
    expect(host.textContent).toContain("No answer selected");
    expect(host.textContent).not.toContain("Your answer");
  });

  it("marks the key, the wrong choice and the explanation once the attempt is final", () => {
    const host = render({
      ...base,
      review: {
        choices: base.options.map(({ label: _label, ...o }) => ({
          ...o,
          correct: o.text === "Gravity",
        })),
        correctNumeric: null,
        unit: null,
        explanation: "Gravity provides the centripetal force.",
      },
    });
    const items = rows(host);
    expect(items[1].textContent).toContain("Correct");
    expect(items[1].className).toContain("green");
    expect(items[2].textContent).toContain("Your answer");
    expect(items[2].className).toContain("destructive");
    expect(items[0].textContent).not.toMatch(/answer|correct/i);
    expect(host.textContent).toContain(
      "Gravity provides the centripetal force.",
    );
  });

  it("labels a correct own choice in a multi-select review", () => {
    const host = render({
      ...base,
      answerMode: "MULTI_SELECT",
      options: base.options.map((o) => ({
        ...o,
        selected: o.label === "B" || o.label === "C",
      })),
      review: {
        choices: base.options.map(({ label: _label, ...o }) => ({
          ...o,
          selected: o.text === "Gravity" || o.text === "Magnetism",
          correct: o.text === "Gravity",
        })),
        correctNumeric: null,
        unit: null,
        explanation: null,
      },
    });
    expect(rows(host)[1].textContent).toContain("Your answer · correct");
    expect(host.textContent).toContain("select all that apply");
  });

  it("shows a numeric answer, and the correct value only when final", () => {
    const numeric: CoachQuestionView = {
      ...base,
      answerMode: "NUMERIC",
      options: [],
      response: { kind: "numeric", value: 12, unit: "m/s" },
    };
    const pending = render(numeric);
    expect(pending.textContent).toContain("Your answer");
    expect(pending.textContent).toContain("12 m/s");
    expect(pending.textContent).not.toContain("Correct answer");

    const final = render({
      ...numeric,
      review: {
        choices: [],
        correctNumeric: 9.8,
        unit: "m/s",
        explanation: null,
      },
    });
    expect(final.textContent).toContain("Correct answer");
    expect(final.textContent).toContain("9.8 m/s");
  });
});
