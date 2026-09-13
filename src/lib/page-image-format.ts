// The storage format for every image derived from a PDF: the rasterized page
// renders behind learning materials and quiz extractions, plus the figure and
// answer-option crops taken out of those renders. Shared by the browser
// rasterizer and by the server routes that mint the presigned PUT keys, so the
// extension in the key can never disagree with the bytes that land under it.
//
// WebP is the default. A rasterized slide is flat colour, line art and text —
// exactly the content PNG stores losslessly at several megabytes a page and
// WebP reproduces at a fraction of the size with no visible loss at the quality
// set below. That matters here beyond the bucket bill: a 100-page document is
// re-read in full by the vision model on every processing pass, and the
// aggregate page budget in `maxDerivedPageBytes` is what a long scanned deck
// used to blow through.
//
// PNG stays a first-class accepted format rather than being replaced outright:
// a browser whose canvas cannot encode WebP silently hands back a PNG blob (see
// `encodeCanvasToPageImage`), and every page/figure key written before this
// change is a `.png` that must keep resolving.

export const PAGE_IMAGE_EXTENSIONS = {
  "image/webp": "webp",
  "image/png": "png",
} as const;

export type PageImageMimeType = keyof typeof PAGE_IMAGE_EXTENSIONS;
export type PageImageExtension = (typeof PAGE_IMAGE_EXTENSIONS)[PageImageMimeType];

/**
 * Every extension a derived-image key may end in, newest first. The completion
 * endpoints check a client-supplied key against the deterministic key for each
 * of these, because the format was negotiated per page at presign time and the
 * completion request does not carry it.
 */
export const PAGE_IMAGE_EXTENSION_VALUES: readonly PageImageExtension[] = ["webp", "png"];

/**
 * The extension the key builders assume when a caller does not negotiate one.
 * PNG, not WebP: an older client that posts no `contentType` is one that will
 * PUT PNG bytes, and the key it is handed has to match.
 */
export const LEGACY_PAGE_IMAGE_EXTENSION: PageImageExtension = "png";

/**
 * Canvas WebP quality for page renders and crops. 0.95 is visually lossless on
 * slide/text content while still landing far below the equivalent PNG — the
 * point is to cut storage without costing the vision model any legibility.
 */
export const PAGE_IMAGE_WEBP_QUALITY = 0.95;

/**
 * The WebP container stores dimensions in 14 bits, so no side may exceed this.
 * Page renders are scaled up before encoding, so an unusually large page can
 * cross it; those fall back to PNG rather than failing the upload.
 */
export const WEBP_MAX_DIMENSION = 16383;

export function pageImageExtension(mimeType: PageImageMimeType): PageImageExtension {
  return PAGE_IMAGE_EXTENSIONS[mimeType];
}

/**
 * Narrow an untrusted `contentType` from a request body to a supported format.
 * `Object.hasOwn`, not `in`: the value is attacker-controlled, and `in` would
 * wave through inherited keys like "toString" — whose "extension" is
 * `undefined`, which would then be baked into a storage key.
 */
export function parsePageImageMimeType(value: unknown): PageImageMimeType | null {
  return typeof value === "string" && Object.hasOwn(PAGE_IMAGE_EXTENSIONS, value)
    ? (value as PageImageMimeType)
    : null;
}

/**
 * The format this deployment renders new pages in. Set
 * `NEXT_PUBLIC_PAGE_IMAGE_FORMAT=png` to opt back out — the escape hatch for a
 * site pointing its vision use cases at a local model server whose image
 * decoder (llama.cpp's bundled stb_image, for instance) does not read WebP.
 *
 * Read on both sides: Next inlines the value into the client bundle at build
 * time, and it is a plain env read on the server. The `typeof` guard is what
 * makes that safe — when the variable is left unset there is nothing for Next to
 * substitute, and a browser bundle with no `process` shim would otherwise throw
 * a ReferenceError here on the first upload rather than fall back to the default.
 */
export function preferredPageImageMimeType(): PageImageMimeType {
  const configured =
    typeof process === "undefined" ? undefined : process.env?.NEXT_PUBLIC_PAGE_IMAGE_FORMAT;
  return configured?.trim().toLowerCase() === "png" ? "image/png" : "image/webp";
}

/**
 * Insert `suffix` before a derived-image key's extension:
 * `.../figure-0.webp` + `-<uuid>` → `.../figure-0-<uuid>.webp`. The figure
 * routes mint a fresh uuid per crop so a retry never has to overwrite a
 * write-once object.
 */
export function suffixPageImageKey(key: string, suffix: string): string {
  const dot = key.lastIndexOf(".");
  return dot === -1 ? `${key}${suffix}` : `${key.slice(0, dot)}${suffix}${key.slice(dot)}`;
}
