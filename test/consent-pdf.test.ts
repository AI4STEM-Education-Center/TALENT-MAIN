import { describe, it, expect } from "vitest";
import { renderConsentPdf, htmlToPlainTextLines } from "@/lib/consent-pdf";

describe("htmlToPlainTextLines", () => {
  it("strips tags, decodes entities, and collapses blank-line runs", () => {
    const lines = htmlToPlainTextLines(
      "<h2>Title</h2><p>Hello &amp; welcome.</p><p></p><p></p><ul><li>One</li><li>Two</li></ul>",
    );
    expect(lines).toContain("Title");
    expect(lines).toContain("Hello & welcome.");
    expect(lines).toContain("- One");
    expect(lines).toContain("- Two");
    // No run of more than one consecutive blank line.
    expect(lines.join("\n")).not.toMatch(/\n\n\n/);
  });

  it("sanitizes characters pdf-lib's WinAnsi font can't encode", () => {
    const lines = htmlToPlainTextLines(
      "<p>&#8216;curly&#8217; and an em—dash and a bullet•</p>",
    );
    const joined = lines.join(" ");
    expect(joined).not.toMatch(/[‘’—•]/);
  });
});

describe("renderConsentPdf", () => {
  it("produces a well-formed PDF buffer containing the form title and signer name", async () => {
    const pdf = await renderConsentPdf(
      {
        role: "STUDENT",
        decision: "AGREE",
        interviewRecordingConsent: true,
        initialsStrokeData: JSON.stringify([
          {
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 10 },
            ],
          },
        ]),
        signatureTypedName: "Ada Lovelace",
        signatureStrokeData: null,
        signedAt: new Date("2026-01-15T12:00:00Z"),
        ipAddress: "127.0.0.1",
        userAgent: "test-agent",
        deviceType: "desktop",
        signerNameSnapshot: "Ada Lovelace",
        signerEmailSnapshot: "ada@example.com",
      },
      {
        title: "Student Consent Form",
        version: "2026-08-06",
        role: "STUDENT",
        bodyHtml: "<h2>Study Purpose</h2><p>This is a test form body.</p>",
      },
    );

    expect(Buffer.isBuffer(pdf)).toBe(true);
    // A valid PDF file always starts with this magic header.
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("still renders when there is no stroke data at all (typed-only signature)", async () => {
    const pdf = await renderConsentPdf(
      {
        role: "TEACHER",
        decision: "DECLINE",
        interviewRecordingConsent: null,
        initialsStrokeData: null,
        signatureTypedName: "Grace Hopper",
        signatureStrokeData: null,
        signedAt: new Date(),
        ipAddress: "10.0.0.1",
        userAgent: "test-agent",
        deviceType: "unknown",
        signerNameSnapshot: "Grace Hopper",
        signerEmailSnapshot: "grace@example.com",
      },
      {
        title: "Instructor Consent Form",
        version: "v1",
        role: "TEACHER",
        bodyHtml: "<p>Body text.</p>",
      },
    );
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
