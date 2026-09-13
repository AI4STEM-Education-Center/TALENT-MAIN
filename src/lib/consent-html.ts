import sanitizeHtml from "sanitize-html";
import {
  CONSENT_ALLOWED_ATTRIBUTES,
  CONSENT_ALLOWED_SCHEMES,
  CONSENT_ALLOWED_TAGS,
  CONSENT_NON_TEXT_TAGS,
} from "@/lib/consent-html-allowlist";

/**
 * Consent text is authored by administrators, but it is rendered to every
 * student/teacher. Keep a deliberately small formatting allowlist so a
 * compromised admin account or pasted HTML cannot become stored XSS.
 *
 * The allowlist lives in its own dependency-free module so the admin publish
 * screen's browser-side preview can hold a draft to the same rules without
 * pulling sanitize-html into the client bundle (see consent-html-preview.ts).
 */
export function sanitizeConsentHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [...CONSENT_ALLOWED_TAGS],
    allowedAttributes: Object.fromEntries(
      Object.entries(CONSENT_ALLOWED_ATTRIBUTES).map(([tag, attrs]) => [tag, [...attrs]])
    ),
    allowedSchemes: [...CONSENT_ALLOWED_SCHEMES],
    // Spelled out rather than left to sanitize-html's default so the preview
    // filter can hold a draft to the identical rule.
    nonTextTags: [...CONSENT_NON_TEXT_TAGS],
    allowProtocolRelative: false,
  });
}
