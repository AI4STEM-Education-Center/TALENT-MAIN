// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminTranscriptCard } from "@/lib/assistant/admin-transcript-types";
import { TranscriptCards } from "./transcript-cards";
import { readCardRef } from "./transcript-card-ref";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mountCards(cards: AdminTranscriptCard[]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<TranscriptCards cards={cards} />);
  });
  return host;
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

const SAMPLE_CARDS: AdminTranscriptCard[] = [
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
        { pageNumber: 12, imageUrl: "https://example.test/page-12.png" },
        { pageNumber: 13, imageUrl: "https://example.test/page-13.png" },
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
      { id: "opt-1", label: "Identify the two objects in a force pair" },
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
    steps: ["Set acceleration to $2\\,\\text{m/s}^2$", "Read both gauges"],
    observe: "Both forces stay equal.",
    interaction: {
      status: "opened",
      openedAt: "2026-11-20T00:00:00Z",
      lastInteractedAt: "2026-11-20T00:00:00Z",
    },
  },
];

describe("admin transcript cards", () => {
  it("renders every card in a compact collapsed view by default", () => {
    const html = renderToStaticMarkup(<TranscriptCards cards={SAMPLE_CARDS} />);

    // Compact summaries & badges are visible immediately
    expect(html).toContain("Course material");
    expect(html).toContain("Chapter 4: Newton&#x27;s Laws · pages 12–14");
    expect(html).toContain("Viewed");
    expect(html).toContain("Diagnostic options");
    expect(html).toContain(
      "Selected “Identify the two objects in a force pair”",
    );
    expect(html).toContain("Chosen");
    expect(html).toContain("Practice question");
    expect(html).toContain("Incorrect");
    expect(html).toContain("Simulation guide");
    expect(html).toContain("Force Pair Explorer");
    expect(html).toContain("Opened");

    // Heavy card bodies and inline page thumbnails stay hidden until clicked
    expect(html).not.toContain("https://example.test/page-12.png");
    expect(html).not.toContain("Compare the forces in a third-law pair");
    expect(html).not.toContain(
      "The forces are equal in magnitude and opposite in direction.",
    );
    expect(html).not.toContain("Read both gauges");
    expect(html).not.toContain("Open current simulation");
    expect(html).not.toContain("Was this useful?");
  });

  it("opens a full-page viewer dialog for course materials and expands diagnostic, practice, and simulation cards on click", async () => {
    const el = await mountCards(SAMPLE_CARDS);
    const buttonMatching = (pattern: RegExp) =>
      Array.from(el.querySelectorAll("button")).find((b) =>
        pattern.test(b.textContent ?? ""),
      );

    // Clicking a course material row opens the full-size page viewer dialog
    await act(async () => buttonMatching(/Course material/)!.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Chapter 4: Newton's Laws");
    expect(dialog?.textContent).toContain("pages 12–14");
    expect(dialog?.querySelectorAll("img")).toHaveLength(2);
    expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.test/page-12.png",
    );
    // Close material dialog
    const closeBtn = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (b) => /close/i.test(b.textContent ?? ""),
    );
    await act(async () => closeBtn!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Clicking diagnostic options expands the full option list with Selected pill
    await act(async () => buttonMatching(/Diagnostic options/)!.click());
    expect(el.textContent).toContain("Which step feels uncertain?");
    expect(el.textContent).toContain("Compare the forces in a third-law pair");
    expect(el.textContent).toContain("Selected");

    // Clicking MCQ practice expands full options, student's answer, and correct answer
    await act(async () =>
      buttonMatching(/A performer stands on a lift/)!.click(),
    );
    expect(el.textContent).toContain("Version B");
    expect(el.textContent).toContain("The floor exerts a greater force.");
    expect(el.textContent).toContain(
      "The forces are equal in magnitude and opposite in direction.",
    );
    expect(el.textContent).toContain("Student's answer");
    expect(el.textContent).toContain("Correct");

    // Clicking numeric practice expands student's answer and correct answer with unit
    await act(async () => buttonMatching(/Compute the net force/)!.click());
    expect(el.textContent).toContain("18 N");
    expect(el.textContent).toContain("24 N");

    // Clicking simulation expands steps, what to watch, and Open current simulation trigger
    await act(async () => buttonMatching(/Simulation guide/)!.click());
    expect(el.textContent).toContain("Read both gauges");
    expect(el.textContent).toContain("Both forces stay equal.");
    expect(el.textContent).toContain("Open current simulation");
  });

  it("summarizes unhydrated coach and study refs in compact collapsed form", () => {
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
    expect(html).toContain("Incorrect");
    expect(html).toContain("Diagnostic options");
    expect(html).toContain("Selected “Carrying”");
    expect(html).toContain("Simulation guide");
    expect(html).toContain("Explore sums");
    expect(html).toContain("Opened");
    expect(html).toContain("Course material");
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
    expect(html).not.toContain("Chosen");
  });
});
