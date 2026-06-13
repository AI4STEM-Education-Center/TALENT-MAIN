import { describe, it, expect } from "vitest";
import { parseRosterCsv, isValidEmail } from "./csv-roster";

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
    const csv = "OrgDefinedId,Last Name,First Name,Email\n1,Doe,Jane,Jane.DOE@UGA.edu";
    const { students } = parseRosterCsv(csv);
    expect(students[0].email).toBe("jane.doe@uga.edu");
  });
});
