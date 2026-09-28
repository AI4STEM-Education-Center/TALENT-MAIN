import { describe, it, expect } from "vitest";
import {
  buildTier1Schema,
  buildTier2Schema,
  buildTier1Prompt,
  buildTier2Prompt,
  formatConceptBulletList,
} from "./vlm-engine";

const LABELS = ["Force Vector: Forces", "Newton's 2nd Law"];

describe("material concept generation", () => {
  for (const buildPrompt of [buildTier1Prompt, buildTier2Prompt]) {
    it(`${buildPrompt.name} allows new concepts with an empty catalog`, () => {
      expect(buildPrompt([])).toContain(
        "generate a concise, specific new label",
      );
    });

    it(`${buildPrompt.name} prefers reuse without restricting descriptions`, () => {
      const prompt = buildPrompt(LABELS);
      expect(prompt).toContain("Reuse an existing concept's exact label");
      expect(prompt).toContain("- Newton's 2nd Law");
      expect(prompt).toContain("Describe all relevant educational content");
      expect(prompt).not.toContain("ONLY from this list");
      expect(prompt).not.toContain("must not introduce unlisted concepts");
    });
  }

  it("retains the page relevance and no-concept instructions", () => {
    const prompt = buildTier1Prompt([]);
    expect(prompt).toContain("without worked solutions or explanations");
    expect(prompt).toContain("mark such pages as not needed");
    expect(prompt).toContain(
      'Use "None" only when the page has no educational concept',
    );
  });

  it("accepts new labels in both structured response schemas", () => {
    expect(buildTier1Schema().schema.properties.key_concept).toEqual({
      type: "string",
    });
    expect(buildTier2Schema().schema.properties.key_concept).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(buildTier1Schema().schema.required).toEqual([
      "needed",
      "key_concept",
      "description",
    ]);
    expect(buildTier2Schema().schema.required).toEqual([
      "key_concept",
      "description",
    ]);
  });

  it("formats catalog labels", () => {
    expect(formatConceptBulletList(["A", "B"])).toBe("- A\n- B");
    expect(formatConceptBulletList([])).toBe("");
  });
});
