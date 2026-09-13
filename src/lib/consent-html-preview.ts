import {
  CONSENT_ALLOWED_ATTRIBUTES,
  CONSENT_ALLOWED_SCHEMES,
  CONSENT_ALLOWED_TAGS,
  CONSENT_NON_TEXT_TAGS,
} from "@/lib/consent-html-allowlist";

/**
 * Browser-side counterpart to sanitizeConsentHtml, for the admin publish
 * screen's preview only. sanitize-html is server-only, so rather than ship it
 * to the client (or render a draft's raw HTML straight into the page) this
 * walks the parsed document with the same allowlist: unknown elements are
 * unwrapped to their text, disallowed attributes and non-http(s)/mailto links
 * are dropped.
 *
 * Not a security boundary for signers — that is sanitizeConsentHtml, which
 * runs when the version is published and again whenever it is served. This
 * exists so the preview shows an admin what publishing will actually keep,
 * and so a draft paste can't script the admin's own page while they review it.
 */
export function previewConsentHtml(html: string): string {
  if (typeof window === "undefined") return "";

  const allowedTags = new Set<string>(CONSENT_ALLOWED_TAGS);
  const nonTextTags = new Set<string>(CONSENT_NON_TEXT_TAGS);
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root");
  if (!root) return "";

  const walk = (node: Element) => {
    // Snapshot the children: unwrapping mutates the live child list.
    for (const child of Array.from(node.children)) walk(child);

    const tag = node.tagName.toLowerCase();
    if (nonTextTags.has(tag) && !allowedTags.has(tag)) {
      node.remove();
      return;
    }
    if (!allowedTags.has(tag)) {
      // Unwrap rather than delete, so text inside an unknown wrapper (a
      // <div>, a <span>) still shows up — matching sanitize-html's default.
      node.replaceWith(...Array.from(node.childNodes));
      return;
    }

    const allowedAttributes = CONSENT_ALLOWED_ATTRIBUTES[tag] ?? [];
    for (const attr of Array.from(node.attributes)) {
      if (!allowedAttributes.includes(attr.name.toLowerCase())) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (attr.name.toLowerCase() === "href" && !isAllowedHref(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
  };

  for (const child of Array.from(root.children)) walk(child);
  return root.innerHTML;
}

function isAllowedHref(value: string): boolean {
  const scheme = value.trim().match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  // Relative links carry no scheme and are harmless.
  if (!scheme) return true;
  return (CONSENT_ALLOWED_SCHEMES as readonly string[]).includes(scheme);
}
