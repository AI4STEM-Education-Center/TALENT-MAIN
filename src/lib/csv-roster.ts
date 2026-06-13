// Shared roster CSV parsing. Used by the "create class" UI (client) to preview
// and validate uploads. Pure module — no server-only imports so it can run in
// the browser.

export interface ParsedRosterStudent {
  orgDefinedId: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface RosterParseResult {
  students: ParsedRosterStudent[];
  /** True when no recognizable header was found and a positional fallback was used. */
  headerInferred: boolean;
  /** Rows dropped because they were missing a required field (id / name / email). */
  skipped: number;
  /** The column header labels that were applied (detected or inferred). */
  headerMap: { orgDefinedId: number; lastName: number; firstName: number; email: number };
}

// Header aliases (lower-cased, trimmed) → logical column.
const ALIASES: Record<keyof RosterParseResult["headerMap"], string[]> = {
  orgDefinedId: ["orgdefinedid", "org defined id", "id", "student id", "studentid", "81 number", "81number"],
  lastName: ["last name", "lastname", "last", "surname", "family name"],
  firstName: ["first name", "firstname", "first", "given name"],
  email: ["email", "e-mail", "email address", "emailaddress", "mail"],
};

// TEMPORARY inferred column order used when a CSV has no recognizable header.
// This mirrors the Brightspace/D2L classlist export shape plus an email column.
// Per request this is a best-effort default to be corrected later.
const FALLBACK_MAP: RosterParseResult["headerMap"] = {
  orgDefinedId: 0,
  lastName: 1,
  firstName: 2,
  email: 3,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** Tokenize a single CSV line, honoring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Attempt to map header columns by name; returns null when nothing matches. */
function detectHeader(headerCols: string[]): RosterParseResult["headerMap"] | null {
  const normalized = headerCols.map((c) => c.toLowerCase().trim());
  const find = (aliases: string[]) =>
    normalized.findIndex((c) => aliases.includes(c));

  const orgDefinedId = find(ALIASES.orgDefinedId);
  const lastName = find(ALIASES.lastName);
  const firstName = find(ALIASES.firstName);
  const email = find(ALIASES.email);

  // Require at least an id-ish column and a name column to trust the header.
  if (orgDefinedId === -1 && firstName === -1 && lastName === -1) return null;

  return {
    orgDefinedId: orgDefinedId === -1 ? FALLBACK_MAP.orgDefinedId : orgDefinedId,
    lastName: lastName === -1 ? FALLBACK_MAP.lastName : lastName,
    firstName: firstName === -1 ? FALLBACK_MAP.firstName : firstName,
    email: email === -1 ? FALLBACK_MAP.email : email,
  };
}

/**
 * Parse a roster CSV. Detects a header row when possible; otherwise falls back
 * to a temporary positional column order (and reports headerInferred=true).
 * Email is required for every student row — rows without a valid email are
 * skipped and counted.
 */
export function parseRosterCsv(text: string): RosterParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return { students: [], headerInferred: false, skipped: 0, headerMap: FALLBACK_MAP };
  }

  const firstCols = splitCsvLine(lines[0]);
  const detected = detectHeader(firstCols);
  const headerInferred = detected === null;
  const map = detected ?? FALLBACK_MAP;

  // When a header was detected, the first line is the header → skip it.
  // When inferred, every line (including the first) is treated as data.
  const dataStart = detected ? 1 : 0;

  const students: ParsedRosterStudent[] = [];
  let skipped = 0;

  for (let i = dataStart; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const orgDefinedId = (cols[map.orgDefinedId] ?? "").replace(/^#/, "").trim();
    const lastName = (cols[map.lastName] ?? "").trim();
    const firstName = (cols[map.firstName] ?? "").trim();
    const email = (cols[map.email] ?? "").trim().toLowerCase();

    if (!orgDefinedId || !firstName || !lastName || !isValidEmail(email)) {
      skipped++;
      continue;
    }
    students.push({ orgDefinedId, firstName, lastName, email });
  }

  return { students, headerInferred, skipped, headerMap: map };
}
