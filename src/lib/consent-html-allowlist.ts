/**
 * The formatting allowlist consent text is held to, shared by the two places
 * that need it: the server-side sanitizer that runs on publish and on render
 * (src/lib/consent-html.ts) and the admin publish screen's preview, which
 * filters in the browser so what an admin sees is what signers will get.
 *
 * Dependency-free on purpose — consent-html.ts pulls in sanitize-html, which
 * must not follow this into a client bundle.
 */

export const CONSENT_ALLOWED_TAGS = [
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
] as const;

/** Attribute allowlist, keyed by tag name. Everything else is dropped. */
export const CONSENT_ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ["href"],
};

export const CONSENT_ALLOWED_SCHEMES = ["http", "https", "mailto"] as const;

/**
 * Tags whose *contents* go too, rather than being unwrapped into text. Every
 * other disallowed tag is unwrapped, so wording inside an unexpected container
 * still survives. sanitize-html applies this as `nonTextTags`; the browser-side
 * preview applies it by removing the subtree — without it, a pasted
 * `<script>alert(1)</script>` would surface as the literal text "alert(1)".
 */
export const CONSENT_NON_TEXT_TAGS = [
  "script",
  "style",
  "textarea",
  "option",
] as const;
