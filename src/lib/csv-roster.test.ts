import { describe, it, expect } from "vitest";
import { parseRosterCsv, isValidEmail, normalizeEmail } from "./csv-roster";

describe("normalizeEmail", () => {
  it("rewrites uga.view.usg.edu to uga.edu", () => {
    expect(normalizeEmail("yue-yin-student@uga.view.usg.edu")).toBe(
      "yue-yin-student@uga.edu",
    );
  });

  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Yue-Yin-Student@UGA.View.USG.edu  ")).toBe(
      "yue-yin-student@uga.edu",
    );
  });

  it("is idempotent", () => {
    const once = normalizeEmail("yue-yin-student@uga.view.usg.edu");
    expect(normalizeEmail(once)).toBe(once);
  });

  it("leaves ordinary addresses untouched", () => {
    expect(normalizeEmail("jane.doe@uga.edu")).toBe("jane.doe@uga.edu");
    expect(normalizeEmail("a@b.com")).toBe("a@b.com");
  });

  it("rewrites only uga.view.usg.edu, not other view.usg.edu hosts", () => {
    expect(normalizeEmail("jane.doe@gatech.view.usg.edu")).toBe(
      "jane.doe@gatech.view.usg.edu",
    );
    expect(normalizeEmail("someone@view.usg.edu")).toBe("someone@view.usg.edu");
    // A sub-labelled variant is not the confirmed host either.
    expect(normalizeEmail("a@mail.uga.view.usg.edu")).toBe(
      "a@mail.uga.view.usg.edu",
    );
  });

  it("only rewrites the domain, never a look-alike local part", () => {
    expect(normalizeEmail("uga.view.usg.edu@example.com")).toBe(
      "uga.view.usg.edu@example.com",
    );
  });

  it("tolerates nullish input", () => {
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
  });
});

describe("isValidEmail", () => {
  it("accepts well-formed addresses", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("first.last@uga.edu")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("missing@domain")).toBe(false);
    expect(isValidEmail("a @b.com")).toBe(false);
  });
});

describe("parseRosterCsv", () => {
  it("parses a CSV with a recognized header row", () => {
    const csv = [
      "OrgDefinedId,Last Name,First Name,Email",
      "#811947904,Doe,Jane,jane.doe@uga.edu",
      "#811947905,Roe,John,john.roe@uga.edu",
    ].join("\n");
    const { students, headerInferred, skipped } = parseRosterCsv(csv);
    expect(headerInferred).toBe(false);
    expect(skipped).toBe(0);
    expect(students).toHaveLength(2);
    expect(students[0]).toEqual({
      orgDefinedId: "811947904",
      lastName: "Doe",
      firstName: "Jane",
      email: "jane.doe@uga.edu",
    });
  });

  it("detects email regardless of column order via the header", () => {
    const csv = [
      "Email,First Name,Last Name,OrgDefinedId",
      "z@uga.edu,Zoe,Zed,42",
    ].join("\n");
    const { students, headerInferred } = parseRosterCsv(csv);
    expect(headerInferred).toBe(false);
    expect(students[0].email).toBe("z@uga.edu");
    expect(students[0].orgDefinedId).toBe("42");
  });

  it("falls back to a temporary positional header when none is recognized", () => {
    const csv = [
      "#811947904,Doe,Jane,jane.doe@uga.edu",
      "#811947905,Roe,John,john.roe@uga.edu",
    ].join("\n");
    const { students, headerInferred } = parseRosterCsv(csv);
    expect(headerInferred).toBe(true);
    // No header row was consumed, so both data rows are kept.
    expect(students).toHaveLength(2);
    expect(students[0].email).toBe("jane.doe@uga.edu");
  });

  it("skips rows missing a valid email", () => {
    const csv = [
      "OrgDefinedId,Last Name,First Name,Email",
      "1,Doe,Jane,jane@uga.edu",
      "2,NoEmail,Bob,",
      "3,BadEmail,Sue,not-an-email",
    ].join("\n");
    const { students, skipped } = parseRosterCsv(csv);
    expect(students).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("honors quoted fields containing commas", () => {
    const csv = [
      "OrgDefinedId,Last Name,First Name,Email",
      '7,"Smith, Jr.",Al,al@uga.edu',
    ].join("\n");
    const { students } = parseRosterCsv(csv);
    expect(students[0].lastName).toBe("Smith, Jr.");
    expect(students[0].email).toBe("al@uga.edu");
  });

  it("lower-cases emails", () => {
    const csv =
      "OrgDefinedId,Last Name,First Name,Email\n1,Doe,Jane,Jane.DOE@UGA.edu";
    const { students } = parseRosterCsv(csv);
    expect(students[0].email).toBe("jane.doe@uga.edu");
  });

  // Exact shape of the D2L/Brightspace grades export teachers upload, including
  // the Username and End-of-Line Indicator columns and the LMS view domain.
  it("parses a D2L grades export and rewrites the LMS email domain", () => {
    const csv = [
      "OrgDefinedId,Username,Last Name,First Name,Email,End-of-Line Indicator",
      "#810086556,#yue-yin-student,Yue,Yin,yue-yin-student@uga.view.usg.edu,#",
      "",
    ].join("\n");
    const { students, headerInferred, skipped, normalizedEmails } =
      parseRosterCsv(csv);
    expect(headerInferred).toBe(false);
    expect(skipped).toBe(0);
    expect(normalizedEmails).toBe(1);
    expect(students).toEqual([
      {
        orgDefinedId: "810086556",
        lastName: "Yue",
        firstName: "Yin",
        email: "yue-yin-student@uga.edu",
      },
    ]);
  });

  it("counts only the rows whose email was actually rewritten", () => {
    const csv = [
      "OrgDefinedId,Last Name,First Name,Email",
      "1,Doe,Jane,jane.doe@uga.view.usg.edu",
      "2,Roe,John,john.roe@uga.edu",
      "3,Poe,Ann,ann.poe@gatech.view.usg.edu",
    ].join("\n");
    const { students, normalizedEmails } = parseRosterCsv(csv);
    expect(students).toHaveLength(3);
    expect(normalizedEmails).toBe(1);
    expect(students.map((s) => s.email)).toEqual([
      "jane.doe@uga.edu",
      "john.roe@uga.edu",
      "ann.poe@gatech.view.usg.edu",
    ]);
  });
});
