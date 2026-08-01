import { describe, it, expect } from "vitest";
import {
  EMAIL_PURPOSES,
  EMAIL_PURPOSE_DEFINITIONS,
  formatFromHeader,
  isEmailAddress,
  isEmailPurpose,
  normalizeLocalPart,
  normalizeSenderDomain,
  renderPurposeMessage,
  renderTemplate,
  resolveSenderIdentity,
} from "./email-purposes";

const SMTP = { fromEmail: "fallback@example.com", fromName: "AI4Talent", senderDomain: null };

describe("normalizeLocalPart", () => {
  it("lowercases and trims a valid prefix", () => {
    expect(normalizeLocalPart("  Password-Reset ")).toBe("password-reset");
  });

  it("accepts dots, dashes and underscores between alphanumerics", () => {
    expect(normalizeLocalPart("no.reply_1-x")).toBe("no.reply_1-x");
  });

  it("rejects prefixes that would break the address", () => {
    for (const bad of ["", "  ", "-lead", "trail.", "has space", "with@at", "a".repeat(65)]) {
      expect(normalizeLocalPart(bad)).toBeNull();
    }
  });
});

describe("normalizeSenderDomain", () => {
  it("strips a pasted @, scheme and path", () => {
    expect(normalizeSenderDomain("@edwarcheng.net")).toBe("edwarcheng.net");
    expect(normalizeSenderDomain("https://edwarcheng.net/mail")).toBe("edwarcheng.net");
    expect(normalizeSenderDomain("noreply@Mail.Edwarcheng.NET")).toBe("mail.edwarcheng.net");
  });

  it("rejects values that aren't hostnames", () => {
    for (const bad of ["", "localhost", "no_underscores.net", "-lead.net", "trailing-.net"]) {
      expect(normalizeSenderDomain(bad)).toBeNull();
    }
  });
});

describe("isEmailAddress", () => {
  it("accepts a plausible address and rejects junk", () => {
    expect(isEmailAddress("someone@example.com")).toBe(true);
    expect(isEmailAddress("someone@example")).toBe(false);
    expect(isEmailAddress("not an address")).toBe(false);
  });
});

describe("isEmailPurpose", () => {
  it("recognizes catalog keys only", () => {
    expect(isEmailPurpose("PASSWORD_RESET")).toBe(true);
    expect(isEmailPurpose("MADE_UP")).toBe(false);
    expect(isEmailPurpose(42)).toBe(false);
  });
});

describe("resolveSenderIdentity", () => {
  it("falls back to the single From address when no domain is configured", () => {
    const identity = resolveSenderIdentity("PASSWORD_RESET", SMTP);
    expect(identity.fromEmail).toBe("fallback@example.com");
    expect(identity.fromName).toBe("AI4Talent");
  });

  it("builds prefix@domain from the catalog default once a domain is set", () => {
    const smtp = { ...SMTP, senderDomain: "edwarcheng.net" };
    expect(resolveSenderIdentity("PASSWORD_RESET", smtp).fromEmail).toBe("password-reset@edwarcheng.net");
    expect(resolveSenderIdentity("NOTIFICATION", smtp).fromEmail).toBe("notification@edwarcheng.net");
    expect(resolveSenderIdentity("CONTACT_TEACHER", smtp).fromEmail).toBe("no-contact@edwarcheng.net");
  });

  it("prefers the admin's overrides over the defaults", () => {
    const identity = resolveSenderIdentity(
      "PASSWORD_RESET",
      { ...SMTP, senderDomain: "edwarcheng.net" },
      { localPart: "Reset", fromName: " Talent Support ", replyTo: "help@edwarcheng.net" }
    );
    expect(identity).toEqual({
      fromEmail: "reset@edwarcheng.net",
      fromName: "Talent Support",
      replyTo: "help@edwarcheng.net",
    });
  });

  it("ignores an unusable override rather than emitting a broken address", () => {
    const identity = resolveSenderIdentity(
      "NOTIFICATION",
      { ...SMTP, senderDomain: "edwarcheng.net" },
      { localPart: "not valid!", replyTo: "also-not-valid" }
    );
    expect(identity.fromEmail).toBe("notification@edwarcheng.net");
    expect(identity.replyTo).toBeNull();
  });
});

describe("formatFromHeader", () => {
  it("omits the angle brackets when there is no display name", () => {
    expect(formatFromHeader({ fromEmail: "a@b.com", fromName: null, replyTo: null })).toBe("a@b.com");
  });

  it("escapes quotes in a display name so it can't inject header content", () => {
    expect(
      formatFromHeader({ fromEmail: "a@b.com", fromName: 'Ev"il', replyTo: null })
    ).toBe('"Ev\\"il" <a@b.com>');
  });
});

describe("renderTemplate", () => {
  it("substitutes known placeholders, including spaced ones", () => {
    expect(renderTemplate("Hi {{firstName}} ({{ username }})", { firstName: "Ada", username: "ada" })).toBe(
      "Hi Ada (ada)"
    );
  });

  it("leaves unknown placeholders visible instead of blanking them", () => {
    expect(renderTemplate("Hi {{nope}}", { firstName: "Ada" })).toBe("Hi {{nope}}");
  });
});

describe("renderPurposeMessage", () => {
  const vars = {
    appName: "AI4Talent",
    firstName: "Ada",
    lastName: "Lovelace",
    username: "ada",
    resetUrl: "https://app.example/reset-password?token=abc",
    expiresInMinutes: 60,
  };

  it("renders the built-in template", () => {
    const { subject, text } = renderPurposeMessage("PASSWORD_RESET", vars);
    expect(subject).toBe("Reset your AI4Talent password");
    expect(text).toContain("Hi Ada,");
    expect(text).toContain("https://app.example/reset-password?token=abc");
    expect(text).toContain("60 minutes");
    expect(text).not.toContain("{{");
  });

  it("uses the admin's override when one is saved", () => {
    const { subject, text } = renderPurposeMessage("PASSWORD_RESET", vars, {
      subject: "Your {{appName}} reset link",
      body: "Go to {{resetUrl}}",
    });
    expect(subject).toBe("Your AI4Talent reset link");
    expect(text).toBe("Go to https://app.example/reset-password?token=abc");
  });

  it("throws for purposes whose body is written by a user", () => {
    expect(() => renderPurposeMessage("NOTIFICATION", vars)).toThrow(/no template/);
  });
});

describe("catalog integrity", () => {
  it("defines every purpose with a valid default prefix", () => {
    for (const purpose of EMAIL_PURPOSES) {
      const definition = EMAIL_PURPOSE_DEFINITIONS[purpose];
      expect(definition.key).toBe(purpose);
      expect(normalizeLocalPart(definition.defaultLocalPart)).toBe(definition.defaultLocalPart);
    }
  });

  it("declares every placeholder its templates actually use", () => {
    for (const purpose of EMAIL_PURPOSES) {
      const { template, variables } = EMAIL_PURPOSE_DEFINITIONS[purpose];
      if (!template) continue;
      const used = [...`${template.subject}\n${template.body}`.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(
        (m) => m[1]
      );
      for (const name of used) expect(variables).toContain(name);
    }
  });
});
