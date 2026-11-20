import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptCards } from "./transcript-cards";
import { readCardRef } from "./transcript-card-ref";

describe("admin transcript cards", () => {
  it("summarizes coach and study refs with the student's recorded interactions", () => {
    const html = renderToStaticMarkup(
      <TranscriptCards
        actions={[
          {
            cardId: "p",
            kind: "practice",
            versionId: "v",
            variantQuestionId: "q",
            reason: "Same skill",
            questionText: "What is 3 + 3?",
            interaction: {
              status: "completed",
              selectedOptionId: "a",
              selectedText: "7",
              numericValue: null,
              correct: false,
              completedAt: "2026-11-20T00:00:00Z",
            },
          },
          {
            source: "study",
            ref: {
              kind: "diagnostic_options",
              prompt: "Where did it go wrong?",
              options: [
                { id: "a", label: "Carrying" },
                { id: "b", label: "Misreading" },
              ],
              interaction: {
                status: "selected",
                selectedLabel: "Carrying",
                selectedAt: "2026-11-20T00:00:00Z",
              },
            },
          },
          {
            kind: "simulation",
            simulationId: "s",
            goal: "Explore sums",
            steps: ["a", "b"],
            observe: "x",
            interaction: {
              status: "opened",
              openedAt: "2026-11-20T00:00:00Z",
              lastInteractedAt: "2026-11-20T00:00:00Z",
            },
          },
          { kind: "material", recommendationIndex: 0, reason: "Read notes" },
          { kind: "unknown" },
        ]}
      />,
    );
    expect(html).toContain("Practice question");
    expect(html).toContain("What is 3 + 3?");
    expect(html).toContain("Answered “7”");
    expect(html).toContain("Incorrect");
    expect(html).toContain("Diagnostic options");
    expect(html).toContain("Selected “Carrying”");
    expect(html).toContain("Carrying · Misreading");
    expect(html).toContain("Simulation guide");
    expect(html).toContain("Opened");
    expect(html).toContain("Course material");
    expect(html).toContain("Recommendation 1: Read notes");
    expect(html).not.toContain("Viewed");
  });

  it("ignores anything that is not a known card", () => {
    expect(readCardRef(null)).toBeNull();
    expect(readCardRef({ source: "study", ref: { kind: "x" } })).toBeNull();
    expect(renderToStaticMarkup(<TranscriptCards actions={[1, "x"]} />)).toBe(
      "",
    );
  });

  it("skips malformed refs instead of crashing the transcript", () => {
    const malformed = [
      { kind: "diagnostic_options", prompt: "Which?", options: "nope" },
      { kind: "diagnostic_options", prompt: "Which?", options: [null] },
      { kind: "diagnostic_options", prompt: 7, options: [] },
      {
        kind: "simulation",
        simulationId: "s",
        goal: "g",
        steps: null,
        observe: "o",
      },
      {
        kind: "simulation",
        simulationId: "s",
        goal: "g",
        steps: [1],
        observe: "o",
      },
      { kind: "material", recommendationIndex: "0", reason: "r" },
      { kind: "material", reason: "r" },
      { kind: "practice", versionId: "v", reason: "r" },
      {
        kind: "practice",
        versionId: "v",
        variantQuestionId: "q",
        reason: "r",
        cardId: 5,
      },
      { source: "study", ref: "not an object" },
      ["material"],
      "material",
      null,
    ];
    for (const raw of malformed) expect(readCardRef(raw)).toBeNull();
    expect(() =>
      renderToStaticMarkup(<TranscriptCards actions={malformed} />),
    ).not.toThrow();
    expect(renderToStaticMarkup(<TranscriptCards actions={malformed} />)).toBe(
      "",
    );
  });

  it("keeps a valid card but drops an interaction it cannot read", () => {
    const ref = readCardRef({
      kind: "practice",
      versionId: "v",
      variantQuestionId: "q",
      reason: "Same skill",
      interaction: { status: "completed", selectedText: 7 },
    });
    expect(ref).toMatchObject({ kind: "practice", reason: "Same skill" });
    expect(ref && "interaction" in ref).toBe(false);
    const html = renderToStaticMarkup(
      <TranscriptCards
        actions={[
          {
            kind: "diagnostic_options",
            prompt: "Which?",
            options: [{ id: "a", label: "A" }],
            interaction: { status: "selected" },
          },
        ]}
      />,
    );
    expect(html).toContain("Options: A");
    expect(html).not.toContain("Selected");
  });
});
