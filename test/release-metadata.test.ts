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

  it("assigns each active week a consecutive patch version and Friday cutoff", () => {
    const { version, changelog } = readReleaseFiles();
    const releases = [
      ...changelog.matchAll(/^##\s+v(0\.0\.(\d+))\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/gm),
    ].map((match, index, matches) => {
      const notesStart = (match.index ?? 0) + match[0].length;
      const notesEnd = matches[index + 1]?.index ?? changelog.length;
      const notes = changelog
        .slice(notesStart, notesEnd)
        .split("\n")
        .filter((line) => line.trim().startsWith("- "));

      return {
        version: match[1] ?? "",
        patch: Number(match[2]),
        date: match[3] ?? "",
        notes,
      };
    });
    const weeklyReleases = releases.filter((release) => release.patch >= 15);

    // Weekly releases run contiguously from 0.0.15 up to whatever version.json
    // currently declares, so derive the expectation instead of restating it every
    // Friday. Contiguity and descending order are still asserted.
    const latestPatch = Number(version.version.split(".")[2]);
    const expectedPatches = Array.from(
      { length: latestPatch - 15 + 1 },
      (_, index) => latestPatch - index
    );

    expect(weeklyReleases.map((release) => release.patch)).toEqual(expectedPatches);
    expect(weeklyReleases[0]?.version).toBe(version.version);
    expect(weeklyReleases[0]?.date).toBe(version.date);
    expect(new Set(weeklyReleases.map((release) => release.date)).size).toBe(
      weeklyReleases.length
    );

    weeklyReleases.forEach((release, index) => {
      expectFriday(release.date);
      expect(
        release.notes.length,
        `${release.version} must list at least one feature`
      ).toBeGreaterThan(0);
      if (index > 0) {
        expect(
          release.date.localeCompare(weeklyReleases[index - 1]?.date ?? "")
        ).toBeLessThan(0);
      }
    });
  });
});
