import { describe, it, expect } from "vitest";
import {
  buildFileSelectionPrompt,
  buildPageSelectionPrompt,
  resolveSelectedMaterial,
  clampPageRange,
  MAX_PAGE_SPAN,
  type CatalogMaterial,
  type CatalogPage,
  type MisconceptionInput,
} from "./recommendation";

const input: MisconceptionInput = {
  questionText: "What is Newton's third law?",
  wrongAnswer: "Forces are zero while accelerating",
  correctAnswer: "Forces are equal and opposite",
};

const materials: CatalogMaterial[] = [
  { index: 1, title: "Forces.pdf", description: "Intro to forces", keyConcepts: ["force", "friction"] },
  { index: 2, title: "Newtons Laws.pdf", description: "All three laws", keyConcepts: ["inertia", "action-reaction"] },
];

describe("buildFileSelectionPrompt", () => {
  it("includes the question, both answers, and every catalog entry", () => {
    const prompt = buildFileSelectionPrompt(input, materials);
    expect(prompt).toContain("What is Newton's third law?");
    expect(prompt).toContain("Forces are zero while accelerating");
    expect(prompt).toContain("Correct Answer: Forces are equal and opposite");
    expect(prompt).toContain("[1] Forces.pdf");
    expect(prompt).toContain("[2] Newtons Laws.pdf");
    expect(prompt).toContain("action-reaction");
    // asks for the index-based structured output
    expect(prompt.toLowerCase()).toContain("material_index");
  });

  it("omits the correct-answer line when none is provided", () => {
    const prompt = buildFileSelectionPrompt({ ...input, correctAnswer: null }, materials);
    expect(prompt).not.toContain("Correct Answer:");
  });

  it("falls back to N/A when a material has no key concepts or description", () => {
    const prompt = buildFileSelectionPrompt(input, [
      { index: 1, title: "Empty.pdf", description: "", keyConcepts: [] },
    ]);
    expect(prompt).toContain("Key Concepts: N/A");
    expect(prompt).toContain("Description: N/A");
  });
});

describe("buildPageSelectionPrompt", () => {
  const pages: CatalogPage[] = [
    { pageNumber: 21, keyConcept: "third law", description: "equal and opposite forces" },
    { pageNumber: 22, keyConcept: "free body diagram", description: "drawing forces" },
  ];

  it("includes the selected material title and each page", () => {
    const prompt = buildPageSelectionPrompt(input, "Newtons Laws.pdf", pages);
    expect(prompt).toContain("Selected Material: Newtons Laws.pdf");
    expect(prompt).toContain("Page 21:");
    expect(prompt).toContain("Page 22:");
    expect(prompt).toContain("equal and opposite forces");
  });
});

describe("resolveSelectedMaterial", () => {
  it("returns the matching material for a valid index", () => {
    expect(resolveSelectedMaterial(2, materials)?.title).toBe("Newtons Laws.pdf");
  });

  it("returns null for an out-of-range index", () => {
    expect(resolveSelectedMaterial(0, materials)).toBeNull();
    expect(resolveSelectedMaterial(99, materials)).toBeNull();
  });
});

describe("clampPageRange", () => {
  const available = [10, 11, 12, 13, 14, 15];

  it("returns the range unchanged when valid", () => {
    expect(clampPageRange(11, 13, available)).toEqual({ start: 11, end: 13 });
  });

  it("clamps out-of-bounds endpoints into the available range", () => {
    expect(clampPageRange(1, 99, available)).toEqual({ start: 10, end: 14 }); // span capped at 5
  });

  it("swaps start and end when reversed", () => {
    expect(clampPageRange(13, 11, available)).toEqual({ start: 11, end: 13 });
  });

  it("caps the span at MAX_PAGE_SPAN", () => {
    const range = clampPageRange(10, 15, available)!;
    expect(range.end - range.start + 1).toBeLessThanOrEqual(MAX_PAGE_SPAN);
    expect(range).toEqual({ start: 10, end: 14 });
  });

  it("returns null when there are no available pages", () => {
    expect(clampPageRange(1, 3, [])).toBeNull();
  });

  it("handles non-finite model output by falling back to the available bounds", () => {
    expect(clampPageRange(Number.NaN, Number.NaN, available)).toEqual({ start: 10, end: 10 });
  });
});
