import { describe, expect, it } from "vitest";
import { sanitizeConsentHtml } from "@/lib/consent-html";

describe("sanitizeConsentHtml", () => {
  it("keeps legal-form formatting while removing executable markup", () => {
    const result = sanitizeConsentHtml(
      '<h2>Consent</h2><script>alert(1)</script><p onclick="steal()">Read <strong>carefully</strong>.</p>',
    );
    expect(result).toBe(
      "<h2>Consent</h2><p>Read <strong>carefully</strong>.</p>",
    );
  });

  it("removes unsafe link schemes", () => {
    expect(sanitizeConsentHtml('<a href="javascript:alert(1)">click</a>')).toBe(
      "<a>click</a>",
    );
  });
});
