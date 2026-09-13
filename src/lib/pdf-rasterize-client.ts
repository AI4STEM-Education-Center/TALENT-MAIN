// Browser-only PDF rasterization shared by the materials upload flow and the
// quiz-PDF import flow. Uses the @hyzyla/pdfium base64 (WASM-inlined) browser
// build, renders each page to a 2x BGRA bitmap, swaps to RGBA for the canvas,
// and encodes one image blob per page. Pure of any app/DB concerns; only touches
// the DOM canvas APIs, so it must run in the browser.

import { PDFiumLibrary } from "@hyzyla/pdfium/browser/base64";
import {
  PAGE_IMAGE_WEBP_QUALITY,
  WEBP_MAX_DIMENSION,
  parsePageImageMimeType,
  preferredPageImageMimeType,
  type PageImageMimeType,
} from "@/lib/page-image-format";

export type RasterizedPage = {
  pageNumber: number;
  blob: Blob;
  sizeBytes: number;
  /**
   * What the canvas actually produced, which is not always what was asked for:
   * a browser that cannot encode WebP hands back PNG instead. Callers must send
   * this to the presign endpoint rather than the requested type, or the key
   * extension and the signed Content-Type will not match the bytes uploaded.
   */
  mimeType: PageImageMimeType;
};

/**
 * Encode a canvas as a page image, returning the format the browser actually
 * used. WebP is requested at a visually lossless quality; the encoder is asked
 * for PNG instead when the bitmap is too large for the WebP container.
 *
 * `canvas.toBlob` with an unsupported type does not throw — it silently falls
 * back to PNG — so the result is read back off `blob.type` rather than assumed.
 */
export async function encodeCanvasToPageImage(
  canvas: HTMLCanvasElement,
  requested: PageImageMimeType
): Promise<{ blob: Blob; mimeType: PageImageMimeType }> {
  const tooBigForWebp =
    canvas.width > WEBP_MAX_DIMENSION || canvas.height > WEBP_MAX_DIMENSION;
  const target: PageImageMimeType =
    requested === "image/webp" && tooBigForWebp ? "image/png" : requested;

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(
      resolve,
      target,
      target === "image/webp" ? PAGE_IMAGE_WEBP_QUALITY : undefined
    )
  );
  if (!blob) throw new Error("Failed to encode page image");

  return { blob, mimeType: parsePageImageMimeType(blob.type) ?? "image/png" };
}

let capabilityProbe: Promise<PageImageMimeType> | null = null;

/**
 * The page-image format this browser can actually produce: the configured
 * preference, downgraded to PNG if the canvas cannot encode it. Probed once with
 * a 1x1 canvas and cached, because callers that presign BEFORE encoding (the
 * quiz figure crops) must commit to one format up front — the server signs each
 * PUT with it, so guessing wrong makes every upload in the batch fail.
 */
export function resolvePageImageMimeType(
  preferred: PageImageMimeType = preferredPageImageMimeType()
): Promise<PageImageMimeType> {
  if (preferred === "image/png") return Promise.resolve(preferred);
  capabilityProbe ??= (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const { mimeType } = await encodeCanvasToPageImage(canvas, "image/webp");
    return mimeType;
  })().catch(() => "image/png" as PageImageMimeType);
  return capabilityProbe;
}

/**
 * Rasterize every page of `file` to an image blob (1-based pageNumber). Throws a
 * descriptive Error if the page count exceeds `maxPages` or if parsing/render
 * fails. Scale 2.0 keeps quality high for the vision LLM.
 *
 * Pages are encoded as WebP by default — see src/lib/page-image-format.ts for
 * why, and for the env switch back to PNG.
 */
export async function rasterizePdfToImageBlobs(
  file: File,
  maxPages: number,
  mimeType: PageImageMimeType = preferredPageImageMimeType()
): Promise<RasterizedPage[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pages: RasterizedPage[] = [];

  // The base64 build inlines the WASM, so there's no worker/CDN to load.
  const library = await PDFiumLibrary.init({ disableBase64Warning: true });
  try {
    const pdfDoc = await library.loadDocument(new Uint8Array(arrayBuffer));
    try {
      const numPages = pdfDoc.getPageCount();

      if (numPages > maxPages) {
        throw new Error(`PDF exceeds maximum limit of ${maxPages} pages (has ${numPages}).`);
      }

      for (let i = 1; i <= numPages; i++) {
        // PDFium renders to a raw BGRA bitmap; scale 2.0 keeps quality high for the VLM.
        const { data, width, height } = await pdfDoc
          .getPage(i - 1) // PDFium pages are 0-indexed
          .render({ scale: 2.0, render: "bitmap" });

        // Canvas ImageData is RGBA, so swap each pixel's B and R bytes in place.
        for (let p = 0; p < data.length; p += 4) {
          const b = data[p];
          data[p] = data[p + 2];
          data[p + 2] = b;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not create canvas context");
        ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);

        const encoded = await encodeCanvasToPageImage(canvas, mimeType).catch(() => null);
        if (!encoded) throw new Error(`Failed to create blob for page ${i}`);

        pages.push({
          pageNumber: i,
          blob: encoded.blob,
          sizeBytes: encoded.blob.size,
          mimeType: encoded.mimeType,
        });
      }
    } finally {
      pdfDoc.destroy();
    }
  } finally {
    library.destroy();
  }

  return pages;
}
