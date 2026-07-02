import { describe, it, expect } from "vitest";
import {
  buildTier1Schema,
  buildTier2Schema,
  buildTier1Prompt,
  buildTier2Prompt,
  formatConceptBulletList,
  resolveTier1KeyConcept,
  filterTier2KeyConcepts,
} from "./vlm-engine";

// These cover the pure schema/prompt/post-validation helpers that constrain
// VLM material-description key-concept selection to the active concept
// catalog (src/lib/concept-catalog.ts). An empty allow-list must reproduce
// today's free-form behavior byte-for-byte — every "empty catalog" case below
// pins down the exact original prompt/schema text so a future edit can't
// silently change default (no-catalog) behavior.

const TODAYS_TIER1_PROMPT =
  "You are analyzing a single page from an educational document. Extract the key concept and a brief description. Determine if this page is needed for understanding the core material (e.g., skip table of contents or blank pages).";

const TODAYS_TIER2_PROMPT =
  "Based on these pages from a learning material, provide a cohesive batch summary and a list of overarching key concepts across the document.";

const TODAYS_TIER1_SCHEMA = {
  name: "page_assessment",
  strict: true,
  schema: {
    type: "object",
    properties: {
      needed: { type: "boolean" },
      key_concept: { type: "string" },
      description: { type: "string" },
    },
    required: ["needed", "key_concept", "description"],
    additionalProperties: false,
  },
};

const TODAYS_TIER2_SCHEMA = {
  name: "batch_summary",
  strict: true,
  schema: {
    type: "object",
    properties: {
      key_concept: { type: "array", items: { type: "string" } },
      description: { type: "string" },
    },
    required: ["key_concept", "description"],
    additionalProperties: false,
  },
};

const LABELS = ["Force Vector: Forces", "Newton's 2nd Law", "Kinematics: Velocity"];

describe("buildTier1Prompt", () => {
  it("returns exactly today's prompt when the catalog is empty", () => {
    expect(buildTier1Prompt([])).toBe(TODAYS_TIER1_PROMPT);
  });

  it("appends the concept list instruction and bullets when non-empty", () => {
    const prompt = buildTier1Prompt(LABELS);
    expect(prompt.startsWith(TODAYS_TIER1_PROMPT)).toBe(true);
    expect(prompt).toContain('Choose key_concept ONLY from this list (use the exact label). If no listed concept fits, use "None".');
    expect(prompt).toContain("- Force Vector: Forces");
    expect(prompt).toContain("- Newton's 2nd Law");
    expect(prompt).toContain("- Kinematics: Velocity");
  });
});

describe("buildTier2Prompt", () => {
  it("returns exactly today's prompt when the catalog is empty", () => {
    expect(buildTier2Prompt([])).toBe(TODAYS_TIER2_PROMPT);
  });

  it("appends the concept list instruction and bullets when non-empty, with no None escape", () => {
    const prompt = buildTier2Prompt(LABELS);
    expect(prompt.startsWith(TODAYS_TIER2_PROMPT)).toBe(true);
    expect(prompt).toContain("Choose key concepts ONLY from this list (use the exact labels). Return an empty list if none apply.");
    expect(prompt).not.toContain("None");
    expect(prompt).toContain("- Force Vector: Forces");
  });
});

describe("formatConceptBulletList", () => {
  it("renders one bullet per label", () => {
    expect(formatConceptBulletList(["A", "B"])).toBe("- A\n- B");
  });

  it("returns an empty string for an empty list", () => {
    expect(formatConceptBulletList([])).toBe("");
  });
});

describe("buildTier1Schema", () => {
  it("returns exactly today's schema when the catalog is empty", () => {
    expect(buildTier1Schema([])).toEqual(TODAYS_TIER1_SCHEMA);
  });

  it("adds an enum (labels + None) to key_concept when non-empty", () => {
    const schema = buildTier1Schema(LABELS);
    expect(schema.schema.properties.key_concept).toEqual({
      type: "string",
      enum: [...LABELS, "None"],
    });
    // Everything else stays intact.
    expect(schema.name).toBe("page_assessment");
    expect(schema.schema.required).toEqual(["needed", "key_concept", "description"]);
    expect(schema.schema.additionalProperties).toBe(false);
  });
});

describe("buildTier2Schema", () => {
  it("returns exactly today's schema when the catalog is empty", () => {
    expect(buildTier2Schema([])).toEqual(TODAYS_TIER2_SCHEMA);
  });

  it("adds an enum of labels (no None) to key_concept items when non-empty", () => {
    const schema = buildTier2Schema(LABELS);
    expect(schema.schema.properties.key_concept).toEqual({
      type: "array",
      items: { type: "string", enum: LABELS },
    });
    expect(schema.name).toBe("batch_summary");
  });
});

describe("resolveTier1KeyConcept (post-validation defense in depth)", () => {
  it("passes the raw value through untouched when the catalog is empty", () => {
    expect(resolveTier1KeyConcept("Anything the model said", [])).toBe("Anything the model said");
  });

  it("maps the None sentinel to null", () => {
    expect(resolveTier1KeyConcept("None", LABELS)).toBeNull();
  });

  it("keeps a value that is in the allowed set", () => {
    expect(resolveTier1KeyConcept("Newton's 2nd Law", LABELS)).toBe("Newton's 2nd Law");
  });

  it("nulls out a value outside the allowed set (provider ignored the schema)", () => {
    expect(resolveTier1KeyConcept("Some Made Up Concept", LABELS)).toBeNull();
  });
});

describe("filterTier2KeyConcepts (post-validation defense in depth)", () => {
  it("passes the raw array through untouched when the catalog is empty", () => {
    expect(filterTier2KeyConcepts(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("filters out values outside the allowed set", () => {
    expect(
      filterTier2KeyConcepts(["Force Vector: Forces", "Bogus Concept", "Kinematics: Velocity"], LABELS)
    ).toEqual(["Force Vector: Forces", "Kinematics: Velocity"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterTier2KeyConcepts(["Bogus"], LABELS)).toEqual([]);
  });
});
