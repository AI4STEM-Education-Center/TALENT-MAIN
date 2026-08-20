export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string[];
}

export interface AppVersionInfo {
  version: string;
  date: string;
  changelogRaw: string;
  changelogEntries: ChangelogEntry[];
}

const changelogHeaderRegex = /^##\s+v?([^\s]+)(?:\s+-\s+([^\n]+))?/gm;

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
    const notes = sectionText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim());

    return {
      version: match[1] ?? "0.0.0",
      date: (match[2] ?? "").trim(),
      notes,
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
