import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type VersionFile = {
  version: string;
  date: string;
};

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function readReleaseFiles() {
  const root = process.cwd();
  const version = JSON.parse(
    fs.readFileSync(path.join(root, "version.json"), "utf8")
  ) as VersionFile;
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  return { version, changelog };
}

function parseIsoDate(value: string): Date | null {
  if (!isoDatePattern.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed;
}

function expectFriday(value: string) {
  const parsed = parseIsoDate(value);
  expect(parsed, `${value} must be a valid ISO date`).not.toBeNull();
  expect(parsed?.getUTCDay(), `${value} must be a Friday cutoff`).toBe(5);
}

describe("weekly release metadata", () => {
  it("uses a Friday cutoff for the current 0.0.x release", () => {
    const { version } = readReleaseFiles();

    expect(version.version).toMatch(/^0\.0\.\d+$/);
    expectFriday(version.date);
  });

  it("keeps the current changelog entry aligned with version.json", () => {
    const { version, changelog } = readReleaseFiles();
    const firstRelease = changelog.match(/^##\s+v([^\s]+)\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/m);

    expect(firstRelease?.[1]).toBe(version.version);
    expect(firstRelease?.[2]).toBe(version.date);
  });

  it("lists non-empty feature groups under descending Friday cutoffs", () => {
    const { version, changelog } = readReleaseFiles();
    const releaseStart = changelog.search(/^##\s+v[^\s]+\s+-\s+\d{4}-\d{2}-\d{2}\s*$/m);
    expect(releaseStart).toBeGreaterThanOrEqual(0);

    const afterHeading = changelog.indexOf("\n", releaseStart);
    const nextRelease = changelog.indexOf("\n## ", afterHeading + 1);
    const currentSection = changelog.slice(
      afterHeading + 1,
      nextRelease === -1 ? changelog.length : nextRelease
    );
    const weekMatches = [
      ...currentSection.matchAll(/^###\s+Week ending\s+(\d{4}-\d{2}-\d{2})\s*$/gm),
    ];
    const weekDates = weekMatches.map((match) => match[1] ?? "");

    expect(weekDates.length).toBeGreaterThan(0);
    expect(new Set(weekDates).size).toBe(weekDates.length);
    expect(weekDates).toEqual([...weekDates].sort((a, b) => b.localeCompare(a)));

    weekMatches.forEach((match, index) => {
      const endDate = match[1] ?? "";
      expectFriday(endDate);
      expect(endDate.localeCompare(version.date)).toBeLessThanOrEqual(0);

      const notesStart = (match.index ?? 0) + match[0].length;
      const notesEnd = weekMatches[index + 1]?.index ?? currentSection.length;
      const notes = currentSection
        .slice(notesStart, notesEnd)
        .split("\n")
        .filter((line) => line.trim().startsWith("- "));
      expect(notes.length, `Week ending ${endDate} must list at least one feature`).toBeGreaterThan(0);
    });
  });
});
