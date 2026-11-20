import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptCards } from "./transcript-cards";
import { readCardRef } from "./transcript-card-ref";

describe("admin transcript cards", () => {
  it("renders rich hydrated course material, diagnostic options, practice question, and simulation cards", () => {
    const html = renderToStaticMarkup(
      <TranscriptCards
        cards={[
          {
            cardId: "m-1",
            kind: "material",
            recommendationIndex: 0,
            reason: "Review Newton's third law.",
            recommendation: {
              materialId: "mat-1",
              materialTitle: "Chapter 4: Newton's Laws",
              pageRange: { start: 12, end: 14 },
              reason: "Covers force pairs in detail.",
              pages: [
                {
                  pageNumber: 12,
                  imageUrl: "https://example.test/page-12.png",
                },
                {
                  pageNumber: 13,
                  imageUrl: "https://example.test/page-13.png",
                },
              ],
            },
            interaction: {
              status: "viewed",
              viewedAt: "2026-11-20T00:00:00Z",
            },
          },
          {
            cardId: "d-1",
            kind: "diagnostic_options",
            prompt: "Which step feels uncertain?",
            options: [
              {
                id: "opt-1",
                label: "Identify the two objects in a force pair",
              },
              { id: "opt-2", label: "Compare the forces in a third-law pair" },
            ],
            interaction: {
              status: "selected",
              selectedOptionId: "opt-1",
              selectedLabel: "Identify the two objects in a force pair",
              selectedAt: "2026-11-20T00:00:00Z",
            },
          },
          {
            cardId: "p-1",
            kind: "practice",
            versionId: "ver-1",
            variantQuestionId: "vq-1",
            reason: "Try a similar lift problem.",
            question: {
              versionId: "ver-1",
              versionName: "Version B",
              questionId: "vq-1",
              text: "A performer stands on a lift accelerating at $1.9\\,\\text{m/s}^2$. How do the forces compare?",
              answerMode: "SINGLE_SELECT",
              answerUnit: null,
              answerNumeric: null,
              options: [
                {
                  id: "a",
                  text: "The floor exerts a greater force.",
                  isCorrect: false,
                },
                {
                  id: "b",
                  text: "The forces are equal in magnitude and opposite in direction.",
                  isCorrect: true,
                },
              ],
            },
            interaction: {
              status: "completed",
              selectedOptionId: "a",
              selectedText: "The floor exerts a greater force.",
              numericValue: null,
              correct: false,
              completedAt: "2026-11-20T00:00:00Z",
            },
          },
          {
            cardId: "p-num",
            kind: "practice",
            versionId: "ver-2",
            variantQuestionId: "vq-2",
            reason: "Check your arithmetic.",
            question: {
              versionId: "ver-2",
              versionName: "Version C",
              questionId: "vq-2",
              text: "Compute the net force.",
              answerMode: "NUMERIC",
              answerUnit: "N",
              answerNumeric: 24,
              options: [],
            },
            interaction: {
              status: "completed",
              selectedOptionId: null,
              selectedText: "18 N",
              numericValue: 18,
              correct: false,
              completedAt: "2026-11-20T00:00:00Z",
            },
          },
          {
            cardId: "s-1",
            kind: "simulation",
            simulationId: "sim-1",
            simulation: {
              simulationId: "sim-1",
              title: "Force Pair Explorer",
              topic: "Newton's Laws",
              learningGoal: "Compare interaction pairs under acceleration.",
              version: 2,
              playable: true,
            },
            goal: "Explore force pairs",
            steps: [
              "Set acceleration to $2\\,\\text{m/s}^2$",
              "Read both gauges",
            ],
            observe: "Both forces stay equal.",
            interaction: {
              status: "opened",
              openedAt: "2026-11-20T00:00:00Z",
              lastInteractedAt: "2026-11-20T00:00:00Z",
            },
          },
        ]}
      />,
    );

    // Course material renders the actual material title, pages, and viewer trigger (without rating form)
    expect(html).toContain("Chapter 4: Newton&#x27;s Laws");
    expect(html).toContain("pages 12–14");
    expect(html).toContain("https://example.test/page-12.png");
    expect(html).toContain("Viewed");
    expect(html).not.toContain("Was this useful?");

    // Diagnostic options renders the full option list and marks the student's selection
    expect(html).toContain("Which step feels uncertain?");
    expect(html).toContain("Identify the two objects in a force pair");
    expect(html).toContain("Compare the forces in a third-law pair");
    expect(html).toContain("Selected");
    expect(html).toContain("Chosen");

    // Practice question renders full choices, student's answer, and correct answer
    expect(html).toContain("Version B");
    expect(html).toContain("The floor exerts a greater force.");
    expect(html).toContain(
      "The forces are equal in magnitude and opposite in direction.",
    );
    expect(html).toContain("Student&#x27;s answer");
    expect(html).toContain("Correct");
    expect(html).toContain("Incorrect");

    // Numeric practice question shows student's answer and correct answer with unit
    expect(html).toContain("18 N");
    expect(html).toContain("24 N");

    // Simulation renders title, steps, observe, and Open current simulation trigger
    expect(html).toContain("Force Pair Explorer");
    expect(html).toContain("Read both gauges");
    expect(html).toContain("Both forces stay equal.");
    expect(html).toContain("Open current simulation");
    expect(html).toContain("Opened");
  });

  it("summarizes unhydrated coach and study refs with graceful fallbacks", () => {
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
    expect(html).toContain("Carrying");
    expect(html).toContain("Misreading");
    expect(html).toContain("Selected");
    expect(html).toContain("Simulation guide");
    expect(html).toContain("Opened");
    expect(html).toContain("Course material");
    expect(html).toContain("Read notes");
    expect(html).toContain("Recommendation 1");
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
    expect(html).toContain("Which?");
    expect(html).toContain("A");
    expect(html).not.toContain("Selected");
  });
});
