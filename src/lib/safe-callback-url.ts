/**
 * Accept only same-origin relative paths as a post-login / post-consent
 * destination. Rejects protocol-relative paths ("//evil.com", "/\\evil.com"),
 * ASCII control characters ("\t", "\r", "\n" stripped by WHATWG URL parsers),
 * and any input that resolves to a different origin.
 */
export function safeRelativeCallbackUrl(
  value: string | null | undefined,
): string | undefined {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(value, "http://localhost");
    if (parsed.origin !== "http://localhost") return undefined;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}
