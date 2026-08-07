import sanitizeHtml from "sanitize-html";

/**
 * Consent text is authored by administrators, but it is rendered to every
 * student/teacher. Keep a deliberately small formatting allowlist so a
 * compromised admin account or pasted HTML cannot become stored XSS.
 */
export function sanitizeConsentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "h2",
      "h3",
      "h4",
      "ul",
      "ol",
      "li",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "blockquote",
      "a",
    ],
    allowedAttributes: {
      a: ["href"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  });
}
