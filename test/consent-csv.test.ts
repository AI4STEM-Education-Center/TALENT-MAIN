import { describe, it, expect } from "vitest";
import { buildConsentExportCsv } from "@/lib/consent-csv";

describe("buildConsentExportCsv", () => {
  it("awards points to signed students and leaves the rest blank, in eLC format", () => {
    const csv = buildConsentExportCsv("Consent Credit", 5, [
      {
        orgDefinedId: "811947904",
        lastName: "Nash",
        firstName: "Aaron",
        signed: true,
      },
      {
        orgDefinedId: "811107402",
        lastName: "Sherer",
        firstName: "Aaron",
        signed: false,
      },
    ]);
    expect(csv).toBe(
      "OrgDefinedId,Last Name,First Name,Consent Credit Points Grade <Numeric MaxPoints:5>,End-of-Line Indicator\r\n" +
        "#811947904,Nash,Aaron,5,#\r\n" +
        "#811107402,Sherer,Aaron,,#\r\n",
    );
  });

  it("never leaks anything about a student's decision beyond the credit outcome", () => {
    const csv = buildConsentExportCsv("Consent Credit", 5, [
      { orgDefinedId: "1", lastName: "Doe", firstName: "Jane", signed: false },
    ]);
    expect(csv).not.toMatch(/decline|agree/i);
  });
});
