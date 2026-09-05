import { describe, it, expect } from "vitest";
import {
  OFFICIAL_CONSENT_FORMS,
  OFFICIAL_CONSENT_VERSION,
} from "@/lib/consent-form-templates";
import { sanitizeConsentHtml } from "@/lib/consent-html";

const ROLES = ["STUDENT", "TEACHER"] as const;

describe("official consent form templates", () => {
  it("publishes a complete, labeled form for both roles", () => {
    for (const role of ROLES) {
      const form = OFFICIAL_CONSENT_FORMS[role];
      expect(form.role).toBe(role);
      expect(form.version).toBe(OFFICIAL_CONSENT_VERSION);
      expect(form.title.length).toBeGreaterThan(0);
      expect(form.title.length).toBeLessThanOrEqual(300);
      expect(form.bodyHtml.length).toBeLessThanOrEqual(200_000);
    }
  });

  it("survives the render-time sanitizer without losing any text", () => {
    // sanitizeConsentHtml strips anything off its small allowlist. If the
    // transcription ever picks up a tag it drops (a <table>, a <div>), the
    // signer would silently see less than the approved form says.
    for (const role of ROLES) {
      const raw = OFFICIAL_CONSENT_FORMS[role].bodyHtml;
      const text = (html: string) =>
        html
          .replace(/<[^>]*>/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim();
      expect(text(sanitizeConsentHtml(raw))).toBe(text(raw));
    }
  });

  it("keeps the clauses the rest of the platform enforces", () => {
    const student = OFFICIAL_CONSENT_FORMS.STUDENT.bodyHtml;
    // The promise the export-approval attestation exists to keep.
    expect(student).toContain(
      "not be known to your course instructor while you are enrolled",
    );
    expect(student).toContain("no impact on your grades");
    // Both forms offer interview recording, which the initials capture backs.
    for (const role of ROLES) {
      expect(OFFICIAL_CONSENT_FORMS[role].bodyHtml).toContain("initials");
      expect(OFFICIAL_CONSENT_FORMS[role].bodyHtml).toContain(
        "xiaoming.zhai@uga.edu",
      );
      expect(OFFICIAL_CONSENT_FORMS[role].bodyHtml).toContain("IRB@uga.edu");
    }
  });

  it("keeps platform-behavior wording out of the legal text", () => {
    // How this website reacts to a decision (e.g. an instructor's access being
    // held) is UI chrome, not part of the IRB-approved form.
    for (const role of ROLES) {
      expect(OFFICIAL_CONSENT_FORMS[role].bodyHtml).not.toMatch(
        /provisioned|AI4Talent pilot platform/,
      );
    }
  });
});
