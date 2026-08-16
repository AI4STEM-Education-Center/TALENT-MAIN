// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { previewConsentHtml } from "@/lib/consent-html-preview";
import { sanitizeConsentHtml } from "@/lib/consent-html";
import { OFFICIAL_CONSENT_FORMS } from "@/lib/consent-form-templates";

describe("previewConsentHtml", () => {
  it("keeps legal-form formatting while removing executable markup", () => {
    const result = previewConsentHtml(
      '<h2>Consent</h2><script>alert(1)</script><p onclick="steal()">Read <strong>carefully</strong>.</p>'
    );
    expect(result).toBe("<h2>Consent</h2><p>Read <strong>carefully</strong>.</p>");
  });

  it("removes unsafe link schemes but keeps allowed ones", () => {
    expect(previewConsentHtml('<a href="javascript:alert(1)">click</a>')).toBe("<a>click</a>");
    expect(previewConsentHtml('<a href="mailto:IRB@uga.edu">IRB</a>')).toBe(
      '<a href="mailto:IRB@uga.edu">IRB</a>'
    );
    expect(previewConsentHtml('<a href="https://uga.edu">UGA</a>')).toBe(
      '<a href="https://uga.edu">UGA</a>'
    );
  });

  it("unwraps disallowed containers instead of dropping their text", () => {
    // Losing the text would make the preview understate the form.
    expect(previewConsentHtml("<div><p>Kept</p></div>")).toBe("<p>Kept</p>");
    expect(previewConsentHtml("<table><tr><td>Cell</td></tr></table>")).toContain("Cell");
  });

  it("agrees with the server sanitizer on the text this build ships", () => {
    // The preview promises "this is what signers will get" — hold it to that
    // for the official forms, which are what admins publish from the UI.
    for (const role of ["STUDENT", "TEACHER"] as const) {
      const body = OFFICIAL_CONSENT_FORMS[role].bodyHtml;
      const normalize = (html: string) => html.replace(/\s+/g, " ").trim();
      expect(normalize(previewConsentHtml(body))).toBe(normalize(sanitizeConsentHtml(body)));
    }
  });
});
