// Concept / Misconception / Concept-Misconception-mapping CSV parsing. Pure
// module — no server-only imports — so it can run in the browser (the admin
// upload UI parses the file client-side and POSTs the parsed rows).
//
// The source files are messy spreadsheet exports: quoted multi-line fields,
// doubled quotes, CRLF line endings, blank rows mid-file, and (for the mapping
// file) a mixed schema where row shape is distinguished per-row rather than by
// column position alone. `parseCsvRecords` below is a proper record-level
// RFC-4180-ish tokenizer (unlike src/lib/csv-roster.ts's line-based
// `splitCsvLine`, which cannot handle a quoted field containing a newline).

/** A concept row parsed from the Concepts CSV. */
export interface ParsedConcept {
  conceptId: string;
  kind: string;
  parentApLo: string | null;
  unit: string | null;
  topic: string | null;
  displayName: string;
  description: string | null;
  sourceLoCode: string | null;
  comments: string | null;
  notes: string | null;
  url: string | null;
  deprecated: boolean;
  deprecationNote: string | null;
}

/** A misconception row parsed from the Misconceptions CSV. */
export interface ParsedMisconception {
  misconceptionId: string;
  statement: string;
  sourceCitation: string | null;
  link: string | null;
  sourceType: string | null;
  notes: string | null;
  deprecated: boolean;
  deprecationNote: string | null;
}

/** A "mapping row" from the mixed-schema Concept<->Misconception CSV. */
export interface ParsedMapping {
  misconceptionId: string;
  conceptId: string;
  confidence: string | null;
  notes: string | null;
}

/** An "external-ref row" from the mixed-schema Concept<->Misconception CSV. */
export interface ParsedExternalRef {
  conceptId: string;
  refCode: string;
  refType: string;
  sourceUrl: string | null;
}

/** A row that was skipped during parsing, with a human-readable reason. */
export interface SkippedRow {
  row: number;
  reason: string;
}

export interface ParseConceptsResult {
  concepts: ParsedConcept[];
  skipped: SkippedRow[];
}

export interface ParseMisconceptionsResult {
  misconceptions: ParsedMisconception[];
  skipped: SkippedRow[];
}

export interface ParseMappingsResult {
  mappings: ParsedMapping[];
  externalRefs: ParsedExternalRef[];
  skipped: SkippedRow[];
}

/** Thrown when a CSV's header doesn't match the expected file type. */
export class CsvHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvHeaderError";
  }
}

// ─── Record-level parser ───────────────────────────────────────────────────

/**
 * Parse raw CSV text into records (rows of trimmed string cells), honoring
 * RFC-4180-ish quoting: double-quoted fields may contain commas, embedded
 * newlines (\n or \r\n), and doubled quotes ("") as an escaped literal quote.
 * Handles bare \r\n and \n line endings outside of quotes equivalently.
 *
 * Unlike a line-splitting tokenizer, this walks the text character-by-character
 * so a quoted field spanning multiple physical lines stays part of one row.
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  let rowHasContent = false;

  const pushCell = () => {
    row.push(cur.trim());
    cur = "";
  };
  const pushRow = () => {
    pushCell();
    records.push(row);
    row = [];
    rowHasContent = false;
  };

  const len = text.length;
  for (let i = 0; i < len; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      rowHasContent = true;
    } else if (ch === ",") {
      pushCell();
      rowHasContent = true;
    } else if (ch === "\r") {
      // Swallow bare \r; the following \n (if any) ends the row.
      if (text[i + 1] === "\n") continue;
      pushRow();
    } else if (ch === "\n") {
      pushRow();
    } else {
      cur += ch;
      rowHasContent = true;
    }
  }

  // Flush the final record if the text didn't end with a newline, or if it did
  // but there's a trailing empty row artifact we don't want to emit.
  if (cur.length > 0 || row.length > 0 || rowHasContent) {
    pushRow();
  }

  // Drop a possible fully-empty trailing record produced by a trailing newline.
  while (
    records.length > 0 &&
    records[records.length - 1].length === 1 &&
    records[records.length - 1][0] === ""
  ) {
    records.pop();
  }

  return records;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Treat empty string or lone whitespace as "no value". */
function cell(row: string[], index: number): string {
  const v = row[index] ?? "";
  return v.trim();
}

function orNull(v: string): string | null {
  return v === "" ? null : v;
}

/** True when every cell in the row is blank (lone whitespace counts as blank). */
function isBlankRow(row: string[]): boolean {
  return row.every((c) => c.trim() === "");
}

function headersMatch(actual: string[], expected: string[]): boolean {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i].trim().toLowerCase() !== expected[i].trim().toLowerCase()) return false;
  }
  return true;
}

// ─── Concepts CSV ───────────────────────────────────────────────────────────

const CONCEPTS_HEADER = [
  "Cleaned_Concept_id",
  "Comments",
  "concept_id",
  "concept_kind",
  "parent_ap_lo",
  "unit",
  "topic",
  "display_name",
  "description",
  "source_lo_code",
  "notes",
  "URL",
];

export function parseConceptsCsv(text: string): ParseConceptsResult {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    throw new CsvHeaderError("File is empty — expected the Concepts CSV header row.");
  }

  const header = records[0];
  if (!headersMatch(header, CONCEPTS_HEADER)) {
    throw new CsvHeaderError(
      "This doesn't look like the Concepts CSV (expected columns starting with " +
        `"${CONCEPTS_HEADER.join(",")}"). Check you're uploading the right file.`
    );
  }

  const concepts: ParsedConcept[] = [];
  const skipped: SkippedRow[] = [];
  const byConceptId = new Map<string, number>(); // conceptId -> index into `concepts`

  for (let i = 1; i < records.length; i++) {
    const rowNum = i + 1; // 1-indexed, matches file line-ish numbering (header = row 1)
    const row = records[i];
    if (isBlankRow(row)) continue; // skip silently per spec

    const cleanedConceptId = cell(row, 0);
    const comments = cell(row, 1);
    const conceptId = cell(row, 2);
    const kind = cell(row, 3);
    const parentApLo = cell(row, 4);
    const unit = cell(row, 5);
    const topic = cell(row, 6);
    const displayName = cell(row, 7);
    const description = cell(row, 8);
    const sourceLoCode = cell(row, 9);
    const notes = cell(row, 10);
    const url = cell(row, 11);

    if (!conceptId) {
      skipped.push({ row: rowNum, reason: "Missing concept_id" });
      continue;
    }

    const isDeprecated = cleanedConceptId.toLowerCase() === "deprecated";

    const parsed: ParsedConcept = {
      conceptId,
      kind,
      parentApLo: orNull(parentApLo),
      unit: orNull(unit),
      topic: orNull(topic),
      displayName: displayName || conceptId,
      description: orNull(description),
      sourceLoCode: orNull(sourceLoCode),
      comments: isDeprecated ? null : orNull(comments),
      notes: orNull(notes),
      url: orNull(url),
      deprecated: isDeprecated,
      deprecationNote: isDeprecated ? orNull(comments) : null,
    };

    const existingIndex = byConceptId.get(conceptId);
    if (existingIndex !== undefined) {
      concepts[existingIndex] = parsed; // last row wins
    } else {
      byConceptId.set(conceptId, concepts.length);
      concepts.push(parsed);
    }
  }

  return { concepts, skipped };
}

// ─── Misconceptions CSV ─────────────────────────────────────────────────────

const MISCONCEPTIONS_HEADER = [
  "linked_concept_id",
  "notes",
  "misconception_id",
  "statement (direct quote from source)",
  "source_citation",
  "link",
  "type",
];

export function parseMisconceptionsCsv(text: string): ParseMisconceptionsResult {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    throw new CsvHeaderError("File is empty — expected the Misconceptions CSV header row.");
  }

  const header = records[0];
  if (!headersMatch(header, MISCONCEPTIONS_HEADER)) {
    throw new CsvHeaderError(
      "This doesn't look like the Misconceptions CSV (expected columns starting with " +
        `"${MISCONCEPTIONS_HEADER.join(",")}"). Check you're uploading the right file.`
    );
  }

  const misconceptions: ParsedMisconception[] = [];
  const skipped: SkippedRow[] = [];
  const byId = new Map<string, number>();

  for (let i = 1; i < records.length; i++) {
    const rowNum = i + 1;
    const row = records[i];
    if (isBlankRow(row)) continue; // skip silently per spec

    const linkedConceptId = cell(row, 0);
    const notes = cell(row, 1);
    const misconceptionId = cell(row, 2);
    const statement = cell(row, 3);
    const sourceCitation = cell(row, 4);
    const link = cell(row, 5);
    const sourceType = cell(row, 6);

    if (!misconceptionId) {
      skipped.push({ row: rowNum, reason: "Missing misconception_id" });
      continue;
    }

    const isDeprecated = linkedConceptId.toLowerCase() === "deprecated";

    const parsed: ParsedMisconception = {
      misconceptionId,
      statement,
      sourceCitation: orNull(sourceCitation),
      link: orNull(link),
      sourceType: orNull(sourceType),
      notes: isDeprecated ? null : orNull(notes),
      deprecated: isDeprecated,
      deprecationNote: isDeprecated ? orNull(notes) : null,
    };

    const existingIndex = byId.get(misconceptionId);
    if (existingIndex !== undefined) {
      misconceptions[existingIndex] = parsed; // last row wins
    } else {
      byId.set(misconceptionId, misconceptions.length);
      misconceptions.push(parsed);
    }
  }

  return { misconceptions, skipped };
}

// ─── Concept<->Misconception mapping CSV (mixed schema) ────────────────────

const MAPPINGS_HEADER = [
  "misconception_id",
  "misconception_statement",
  "mapped_concept_id",
  "concept_display_name",
  "confidence",
  "notes",
];

const MISCONCEPTION_ID_RE = /^MIS-\d+$/;
const EXTERNAL_REF_TYPES = new Set(["heuristic", "primary"]);

export function parseMappingsCsv(text: string): ParseMappingsResult {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    throw new CsvHeaderError("File is empty — expected the Concept-Misconception mapping CSV header row.");
  }

  const header = records[0];
  if (!headersMatch(header, MAPPINGS_HEADER)) {
    throw new CsvHeaderError(
      "This doesn't look like the Concept<->Misconception mapping CSV (expected columns starting with " +
        `"${MAPPINGS_HEADER.join(",")}"). Check you're uploading the right file.`
    );
  }

  const mappings: ParsedMapping[] = [];
  const externalRefs: ParsedExternalRef[] = [];
  const skipped: SkippedRow[] = [];
  const mappingKeys = new Map<string, number>(); // "misconceptionId|conceptId" -> index into `mappings`
  const externalRefKeys = new Map<string, number>(); // "conceptId|refCode|refType" -> index into `externalRefs`

  for (let i = 1; i < records.length; i++) {
    const rowNum = i + 1;
    const row = records[i];
    if (isBlankRow(row)) continue; // skip silently per spec

    const col0 = cell(row, 0);
    const col1 = cell(row, 1);
    const col2 = cell(row, 2);
    const col3 = cell(row, 3);
    const col4 = cell(row, 4);
    const col5 = cell(row, 5);

    if (MISCONCEPTION_ID_RE.test(col0)) {
      // Mapping row: { misconceptionId: col0, conceptId: col2, confidence: col4, notes: col5 }
      // col1 (misconception_statement) / col3 (concept_display_name) are
      // redundant denormalized text kept only for potential validation
      // warnings client-side — not stored.
      if (!col2) {
        skipped.push({ row: rowNum, reason: `Mapping row for ${col0} is missing mapped_concept_id` });
        continue;
      }
      const parsed: ParsedMapping = {
        misconceptionId: col0,
        conceptId: col2,
        confidence: orNull(col4),
        notes: orNull(col5),
      };
      const key = `${parsed.misconceptionId}|${parsed.conceptId}`;
      const existingIndex = mappingKeys.get(key);
      if (existingIndex !== undefined) {
        mappings[existingIndex] = parsed; // last row wins
      } else {
        mappingKeys.set(key, mappings.length);
        mappings.push(parsed);
      }
      continue;
    }

    if (EXTERNAL_REF_TYPES.has(col2.toLowerCase())) {
      // External-ref row: { conceptId: col0, refCode: col1, refType: col2, sourceUrl: col3 }
      if (!col0 || !col1) {
        skipped.push({ row: rowNum, reason: "External-ref row is missing concept id or ref code" });
        continue;
      }
      const parsed: ParsedExternalRef = {
        conceptId: col0,
        refCode: col1,
        refType: col2.toLowerCase(),
        sourceUrl: orNull(col3),
      };
      const key = `${parsed.conceptId}|${parsed.refCode}|${parsed.refType}`;
      const existingIndex = externalRefKeys.get(key);
      if (existingIndex !== undefined) {
        externalRefs[existingIndex] = parsed; // last row wins
      } else {
        externalRefKeys.set(key, externalRefs.length);
        externalRefs.push(parsed);
      }
      continue;
    }

    skipped.push({ row: rowNum, reason: `Unrecognized row shape (col0="${col0}", col2="${col2}")` });
  }

  return { mappings, externalRefs, skipped };
}
