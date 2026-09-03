import { describe, it, expect } from "vitest";
import {
  buildMaterialSelectionPrompt,
  buildPageSelectionPrompt,
  resolveSelectedMaterial,
  dedupeSelectedMaterials,
  clampPageRange,
  MAX_PAGE_SPAN,
  MAX_MATERIALS,
  type CatalogMaterial,
  type CatalogPage,
  type HolisticAttempt,
  type SelectedMaterial,
} from "./recommendation";

const attempt: HolisticAttempt = {
  questions: [
    { questionText: "What is Newton's third law?", isCorrect: false },
    { questionText: "Define velocity", isCorrect: true },
  ],
  correctCount: 1,
  incorrectCount: 1,
};

const materials: CatalogMaterial[] = [
  {
    index: 1,
    title: "Forces.pdf",
    description: "Intro to forces",
    keyConcepts: ["force", "friction"],
  },
  {
    index: 2,
    title: "Newtons Laws.pdf",
    description: "All three laws",
    keyConcepts: ["inertia", "action-reaction"],
  },
  {
    index: 3,
    title: "Kinematics.pdf",
    description: "Motion",
    keyConcepts: ["velocity"],
  },
  {
    index: 4,
    title: "Energy.pdf",
    description: "Work & energy",
    keyConcepts: ["work"],
  },
];

describe("buildMaterialSelectionPrompt", () => {
  it("includes the covered topics, overall counts, and every catalog entry", () => {
    const prompt = buildMaterialSelectionPrompt(attempt, materials);
    expect(prompt).toContain("What is Newton's third law?");
    expect(prompt).toContain("Define velocity");
    expect(prompt).toContain("1 correctly and 1 incorrectly");
    expect(prompt).toContain("[1] Forces.pdf");
    expect(prompt).toContain("[2] Newtons Laws.pdf");
    expect(prompt).toContain("action-reaction");
    expect(prompt.toLowerCase()).toContain("at most 3");
  });

  it("never instructs the model to reveal what the student got wrong", () => {
    const prompt = buildMaterialSelectionPrompt(attempt, materials);
    // It must explicitly forbid revealing specifics.
    expect(prompt.toLowerCase()).toContain("never reveal");
    // It does NOT label individual questions as wrong/correct.
    expect(prompt).not.toContain("Wrong Answer");
    expect(prompt).not.toContain("Correct Answer");
  });

  it("falls back to N/A when a material has no key concepts or description", () => {
    const prompt = buildMaterialSelectionPrompt(attempt, [
      { index: 1, title: "Empty.pdf", description: "", keyConcepts: [] },
    ]);
    expect(prompt).toContain("Key Concepts: N/A");
    expect(prompt).toContain("Description: N/A");
  });
});

describe("buildPageSelectionPrompt", () => {
  const pages: CatalogPage[] = [
    {
      pageNumber: 21,
      keyConcept: "third law",
      description: "equal and opposite forces",
    },
    {
      pageNumber: 22,
      keyConcept: "free body diagram",
      description: "drawing forces",
    },
  ];

  it("includes the selected material title, each page, and the holistic context", () => {
    const prompt = buildPageSelectionPrompt(attempt, "Newtons Laws.pdf", pages);
    expect(prompt).toContain("Selected Material: Newtons Laws.pdf");
    expect(prompt).toContain("Page 21:");
    expect(prompt).toContain("Page 22:");
    expect(prompt).toContain("equal and opposite forces");
    expect(prompt.toLowerCase()).toContain("has_relevant_pages");
    expect(prompt.toLowerCase()).toContain("never reveal");
  });
});

describe("resolveSelectedMaterial", () => {
  it("returns the matching material for a valid index", () => {
    expect(resolveSelectedMaterial(2, materials)?.title).toBe(
      "Newtons Laws.pdf",
    );
  });

  it("returns null for an out-of-range index", () => {
    expect(resolveSelectedMaterial(0, materials)).toBeNull();
    expect(resolveSelectedMaterial(99, materials)).toBeNull();
  });
});

describe("dedupeSelectedMaterials", () => {
  const sel = (i: number): SelectedMaterial => ({
    material_index: i,
    reasoning: `r${i}`,
  });

  it("caps at MAX_MATERIALS (3), preserving order, and reports truncation", () => {
    const { kept, truncated } = dedupeSelectedMaterials(
      [sel(1), sel(2), sel(3), sel(4)],
      materials,
    );
    expect(kept.map((k) => k.material_index)).toEqual([1, 2, 3]);
    expect(kept).toHaveLength(MAX_MATERIALS);
    expect(truncated).toBe(true);
  });

  it("drops duplicate indices, keeping the first occurrence", () => {
    const { kept, truncated } = dedupeSelectedMaterials(
      [sel(2), sel(2), sel(1)],
      materials,
    );
    expect(kept.map((k) => k.material_index)).toEqual([2, 1]);
    expect(truncated).toBe(false);
  });

  it("drops indices that don't resolve to a catalog entry", () => {
    const { kept } = dedupeSelectedMaterials([sel(99), sel(1)], materials);
    expect(kept.map((k) => k.material_index)).toEqual([1]);
  });

  it("returns an empty list for no selections", () => {
    expect(dedupeSelectedMaterials([], materials)).toEqual({
      kept: [],
      truncated: false,
    });
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
    expect(clampPageRange(Number.NaN, Number.NaN, available)).toEqual({
      start: 10,
      end: 10,
    });
  });
});
