export interface ChangelogWeek {
  endDate: string;
  notes: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string[];
  /**
   * Optional weekly groups for catch-up releases. Older flat changelog entries
   * deliberately omit this field so their parsed shape and rendering stay the
   * same.
   */
  weeks?: ChangelogWeek[];
}

export interface AppVersionInfo {
  version: string;
  date: string;
  changelogRaw: string;
  changelogEntries: ChangelogEntry[];
}

const changelogHeaderRegex = /^##\s+v?([^\s]+)(?:\s+-\s+([^\n]+))?/gm;
const weekHeaderRegex = /^###\s+Week ending\s+(\d{4}-\d{2}-\d{2})\s*$/gm;

function parseBulletNotes(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function parseChangelogWeeks(sectionText: string): ChangelogWeek[] {
  const matches = [...sectionText.matchAll(weekHeaderRegex)];

  return matches.map((match, index) => {
    const notesStart = (match.index ?? 0) + match[0].length;
    const nextStart = matches[index + 1]?.index ?? sectionText.length;

    return {
      endDate: match[1] ?? "",
      notes: parseBulletNotes(sectionText.slice(notesStart, nextStart)),
    };
  });
}

function parseChangelog(markdown: string): ChangelogEntry[] {
  if (!markdown.trim()) {
    return [];
  }

  const matches = [...markdown.matchAll(changelogHeaderRegex)];
  if (matches.length === 0) {
    return [];
  }

  return matches.map((match, index) => {
    const sectionStart = match.index ?? 0;
    const notesStart = sectionStart + match[0].length;
    const nextStart = matches[index + 1]?.index ?? markdown.length;

    const sectionText = markdown.slice(notesStart, nextStart).trim();
    const notes = parseBulletNotes(sectionText);
    const weeks = parseChangelogWeeks(sectionText);

    return {
      version: match[1] ?? "0.0.0",
      date: (match[2] ?? "").trim(),
      notes,
      ...(weeks.length > 0 ? { weeks } : {}),
    };
  });
}

export function getVersionInfo(): AppVersionInfo {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
  const date = process.env.NEXT_PUBLIC_RELEASE_DATE ?? "";
  const changelogRaw = process.env.NEXT_PUBLIC_CHANGELOG ?? "";

  return {
    version,
    date,
    changelogRaw,
    changelogEntries: parseChangelog(changelogRaw),
  };
}
