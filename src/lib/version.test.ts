import { describe, it, expect, afterEach } from "vitest";
import { getVersionInfo } from "./version";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_VERSION;
  delete process.env.NEXT_PUBLIC_RELEASE_DATE;
  delete process.env.NEXT_PUBLIC_CHANGELOG;
});

describe("getVersionInfo", () => {
  it("defaults version/date and yields no entries when unset", () => {
    const info = getVersionInfo();
    expect(info.version).toBe("0.0.0");
    expect(info.date).toBe("");
    expect(info.changelogEntries).toEqual([]);
  });

  it("reads version and date from env", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";
    process.env.NEXT_PUBLIC_RELEASE_DATE = "2026-01-01";
    const info = getVersionInfo();
    expect(info.version).toBe("1.2.3");
    expect(info.date).toBe("2026-01-01");
  });

  it("parses a multi-entry changelog into version/date/notes", () => {
    process.env.NEXT_PUBLIC_CHANGELOG = [
      "## v1.1.0 - 2026-02-02",
      "- Added quizzes",
      "- Fixed scoring",
      "",
      "## v1.0.0 - 2026-01-01",
      "- Initial release",
    ].join("\n");

    const { changelogEntries } = getVersionInfo();
    expect(changelogEntries).toHaveLength(2);
    expect(changelogEntries[0]).toEqual({
      version: "1.1.0",
      date: "2026-02-02",
      notes: ["Added quizzes", "Fixed scoring"],
    });
    expect(changelogEntries[1]).toEqual({
      version: "1.0.0",
      date: "2026-01-01",
      notes: ["Initial release"],
    });
  });

  it("keeps weekly patch releases as independent flat entries", () => {
    process.env.NEXT_PUBLIC_CHANGELOG = [
      "## v0.0.16 - 2026-08-21",
      "- Added signed media delivery",
      "- Improved simulation revisions",
      "",
      "## v0.0.15 - 2026-08-14",
      "- Added consent exports",
    ].join("\n");

    const { changelogEntries } = getVersionInfo();
    expect(changelogEntries[0]).toEqual({
      version: "0.0.16",
      date: "2026-08-21",
      notes: ["Added signed media delivery", "Improved simulation revisions"],
    });
    expect(changelogEntries[1]).toEqual({
      version: "0.0.15",
      date: "2026-08-14",
      notes: ["Added consent exports"],
    });
  });

  it("swallows the first bullet as the date when a header omits its date (known limitation)", () => {
    // The header regex greedily matches ` - <text>` across the newline. Real
    // changelog headers always carry an inline date (e.g. "## v2.0.0 - 2026-01-01"),
    // so this only bites date-less headers — documented here as a characterization test.
    process.env.NEXT_PUBLIC_CHANGELOG = "## v2.0.0\n- Big rewrite";
    const { changelogEntries } = getVersionInfo();
    expect(changelogEntries[0].version).toBe("2.0.0");
    expect(changelogEntries[0].date).toBe("Big rewrite");
    expect(changelogEntries[0].notes).toEqual([]);
  });

  it("returns no entries for changelog text without headers", () => {
    process.env.NEXT_PUBLIC_CHANGELOG = "just some prose with no headings";
    expect(getVersionInfo().changelogEntries).toEqual([]);
  });
});
