import { describe, it, expect } from "vitest";
import {
  parseCsvRecords,
  parseConceptsCsv,
  parseMisconceptionsCsv,
  parseMappingsCsv,
  CsvHeaderError,
} from "./concept-csv";

// Fixture content copied verbatim (structurally identical to the real ~120/90/190
// row exports, trimmed to the variants that exercise every parsing branch).

const CONCEPTS_CSV = [
  "Cleaned_Concept_id,Comments,concept_id,concept_kind,parent_ap_lo,unit,topic,display_name,description,source_lo_code,notes,URL,,Updated June 7,,Reviewed,",
  'F-FV-1,5/20/2026,F-FV-1,detailed_lo,AP-2.2.A,Forces,Force Vector,Force Vector: Forces,"Outcome: Distinguish forces from components of forces\nProvided: graphical or verbal representation of a situation\nTask type: Conc.ID",F-FV-1,,https://example.com/lo3-4,,,,,',
  'N2-N2-1,5/20/2026,N2-N2-1,detailed_lo,AP-2.2.B.2,N2D,"Newton\'s 2nd Law",Newton\'s 2nd Law: External Forces on Object,"Outcome: Correctly identify external forces on an object. Do not include ""force of motion"", ""force of acceleration"" or force not directly applying on the object\nProvided: description of accelerating object\nTask type: Conc.ID",N2-N2-1, ,https://example.com/lo3-4,,,,,',
  'AP-2.2.A,5/21/2026,AP-2.2.A,ap_lo, ,Forces and Free-Body Diagrams,AP 2.2.A,Describe a force as an interaction between two objects or systems,Describe a force as an interaction between two objects or systems,2.2.A,"Direct quote from AP Physics C CED, prepared by Jack Bartley.",https://example.com/doc,,,,,',
  ",,,,,,,,,,,,,,,,",
  ",,,,,,,,,,,,,,,,",
  'deprecated,"AP-2.4.A.2 uses term ""Net Force""",F-FV-3,detailed_lo,AP-2.4.A.1,Forces,Force Vector,Force Vector: net force,"Outcome: find the sum of all forces, or sum of forces on one direction\nProvided: multiple forces on an object\nTask type: Proc.app",F-FV-3,,https://example.com/lo3-4,,,,,',
  // Duplicate concept_id — last row wins (F-FV-1 redefined).
  'F-FV-1,5/22/2026,F-FV-1,detailed_lo,AP-2.2.A,Forces,Force Vector,Force Vector: Forces (revised),"Revised outcome text",F-FV-1,,https://example.com/lo3-4-v2,,,,,',
].join("\r\n");

const MISCONCEPTIONS_CSV = [
  "linked_concept_id,notes,misconception_id,statement (direct quote from source),source_citation,link,type,Updated May 21,,,,,",
  ',,MIS-001,Force is energy.,"Liu, Gang, and Ning Fang. ""Student misconceptions"".",https://example.com/liu,source-list entry,,,,,,',
  ",,,,,,,,,,,,",
  ",,,,,,,,,,,,",
  "deprecated,MIS-078 is more in depth,MIS-011,Faster moving objects have larger force acting on them.,Liu et al.,https://example.com/liu,source-list entry,,,,,,",
  ",similar to MIS-011,MIS-015,there is a force of motion that should be included on the FBD.,Word document comment,https://example.com/doc,Word comment,,,,,,",
].join("\n");

const MAPPINGS_CSV = [
  "misconception_id,misconception_statement,mapped_concept_id,concept_display_name,confidence,notes,Update June 7",
  "MIS-001,Force is energy.,F-FV-1,Force Vector: Forces,Low,Nature-of-force category error. FLAG.,",
  "MIS-038,Capture point ambiguous.,F-FBD-1,Free Body Diagram: Draw FBD,Low,Statement ambiguous. VERIFY.,",
  "F-FF-1,F-FF-1.M1,heuristic,https://example.com/bank,,,",
  ",,,,,,",
  "AP-2.2.A,MC-LIU-20,primary,https://example.com/doc,,,",
  "this is garbage,,,,,,",
  // Duplicate mapping key — last row wins (confidence changes High -> Medium).
  "MIS-001,Force is energy.,F-FV-1,Force Vector: Forces,High,Updated confidence.,",
].join("\n");

describe("parseCsvRecords", () => {
  it("splits simple comma-separated rows", () => {
    expect(parseCsvRecords("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas and doubled quotes", () => {
    const text = 'name,note\n"Doe, Jane","She said ""hi"" once"';
    expect(parseCsvRecords(text)).toEqual([
      ["name", "note"],
      ["Doe, Jane", 'She said "hi" once'],
    ]);
  });

  it("handles multi-line quoted fields (embedded \\n)", () => {
    const text = 'id,description\n1,"line one\nline two\nline three"';
    const records = parseCsvRecords(text);
    expect(records).toEqual([
      ["id", "description"],
      ["1", "line one\nline two\nline three"],
    ]);
  });

  it("handles CRLF line endings, including inside quoted fields", () => {
    const text = 'id,description\r\n1,"line one\r\nline two"\r\n2,plain';
    const records = parseCsvRecords(text);
    expect(records).toEqual([
      ["id", "description"],
      ["1", "line one\r\nline two"],
      ["2", "plain"],
    ]);
  });

  it("trims cell whitespace", () => {
    expect(parseCsvRecords(" a , b ,c\n")).toEqual([["a", "b", "c"]]);
  });

  it("strips a UTF-8 BOM before the first header", () => {
    expect(parseCsvRecords("\uFEFFa,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseConceptsCsv", () => {
  it("rejects a header that doesn't match the Concepts file shape", () => {
    expect(() => parseConceptsCsv(MISCONCEPTIONS_CSV)).toThrow(CsvHeaderError);
  });

  it("parses a multi-line quoted description", () => {
    const { concepts } = parseConceptsCsv(CONCEPTS_CSV);
    const n2 = concepts.find((c) => c.conceptId === "N2-N2-1");
    expect(n2).toBeDefined();
    expect(n2!.description).toContain(
      "Outcome: Correctly identify external forces",
    );
    expect(n2!.description).toContain('"force of motion"'); // doubled-quote unescaping
    expect(n2!.description).toContain("Task type: Conc.ID");
  });

  it("marks deprecated rows and stores the deprecation note from Comments", () => {
    const { concepts } = parseConceptsCsv(CONCEPTS_CSV);
    const dep = concepts.find((c) => c.conceptId === "F-FV-3");
    expect(dep).toBeDefined();
    expect(dep!.deprecated).toBe(true);
    expect(dep!.deprecationNote).toBe('AP-2.4.A.2 uses term "Net Force"');
    expect(dep!.comments).toBeNull();
  });

  it("skips fully blank rows silently", () => {
    const { concepts, skipped } = parseConceptsCsv(CONCEPTS_CSV);
    // 5 non-blank data rows (2 blank rows skipped silently, not counted in
    // `skipped`), one of which is a duplicate concept_id -> 4 unique concepts.
    expect(concepts).toHaveLength(4);
    expect(skipped).toHaveLength(0);
  });

  it("keeps the last row on duplicate concept_id (last wins)", () => {
    const { concepts } = parseConceptsCsv(CONCEPTS_CSV);
    const matches = concepts.filter((c) => c.conceptId === "F-FV-1");
    expect(matches).toHaveLength(1);
    expect(matches[0].displayName).toBe("Force Vector: Forces (revised)");
    expect(matches[0].description).toBe("Revised outcome text");
  });

  it("treats a lone space in parent_ap_lo as blank", () => {
    const { concepts } = parseConceptsCsv(CONCEPTS_CSV);
    const apLo = concepts.find((c) => c.conceptId === "AP-2.2.A");
    expect(apLo!.parentApLo).toBeNull();
  });
});

describe("parseMisconceptionsCsv", () => {
  it("rejects a header that doesn't match the Misconceptions file shape", () => {
    expect(() => parseMisconceptionsCsv(CONCEPTS_CSV)).toThrow(CsvHeaderError);
  });

  it("parses ordinary rows", () => {
    const { misconceptions } = parseMisconceptionsCsv(MISCONCEPTIONS_CSV);
    const mis001 = misconceptions.find((m) => m.misconceptionId === "MIS-001");
    expect(mis001).toBeDefined();
    expect(mis001!.statement).toBe("Force is energy.");
    expect(mis001!.deprecated).toBe(false);
  });

  it("marks deprecated rows and stores the deprecation note from notes", () => {
    const { misconceptions } = parseMisconceptionsCsv(MISCONCEPTIONS_CSV);
    const dep = misconceptions.find((m) => m.misconceptionId === "MIS-011");
    expect(dep).toBeDefined();
    expect(dep!.deprecated).toBe(true);
    expect(dep!.deprecationNote).toBe("MIS-078 is more in depth");
    expect(dep!.notes).toBeNull();
  });

  it("stores freeform notes verbatim for non-deprecated rows", () => {
    const { misconceptions } = parseMisconceptionsCsv(MISCONCEPTIONS_CSV);
    const mis015 = misconceptions.find((m) => m.misconceptionId === "MIS-015");
    expect(mis015!.notes).toBe("similar to MIS-011");
  });

  it("skips fully blank rows silently", () => {
    const { misconceptions, skipped } =
      parseMisconceptionsCsv(MISCONCEPTIONS_CSV);
    expect(misconceptions).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });
});

describe("parseMappingsCsv", () => {
  it("rejects a header that doesn't match the mapping file shape", () => {
    expect(() => parseMappingsCsv(CONCEPTS_CSV)).toThrow(CsvHeaderError);
  });

  it("parses mapping rows (MIS- prefixed)", () => {
    const { mappings } = parseMappingsCsv(MAPPINGS_CSV);
    const m038 = mappings.find((m) => m.misconceptionId === "MIS-038");
    expect(m038).toEqual({
      misconceptionId: "MIS-038",
      conceptId: "F-FBD-1",
      confidence: "Low",
      notes: "Statement ambiguous. VERIFY.",
    });
  });

  it("parses external-ref rows (heuristic / primary)", () => {
    const { externalRefs } = parseMappingsCsv(MAPPINGS_CSV);
    expect(externalRefs).toContainEqual({
      conceptId: "F-FF-1",
      refCode: "F-FF-1.M1",
      refType: "heuristic",
      sourceUrl: "https://example.com/bank",
    });
    expect(externalRefs).toContainEqual({
      conceptId: "AP-2.2.A",
      refCode: "MC-LIU-20",
      refType: "primary",
      sourceUrl: "https://example.com/doc",
    });
  });

  it("skips blank rows silently and reports unrecognized row shapes as warnings", () => {
    const { skipped } = parseMappingsCsv(MAPPINGS_CSV);
    // Only the "this is garbage" row should be reported; the blank row is silent.
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/Unrecognized row shape/);
  });

  it("keeps the last row on duplicate mapping key (last wins)", () => {
    const { mappings } = parseMappingsCsv(MAPPINGS_CSV);
    const matches = mappings.filter(
      (m) => m.misconceptionId === "MIS-001" && m.conceptId === "F-FV-1",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBe("High");
    expect(matches[0].notes).toBe("Updated confidence.");
  });
});
