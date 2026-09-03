// Browser-only PDF rasterization shared by the materials upload flow and the
// quiz-PDF import flow. Uses the @hyzyla/pdfium base64 (WASM-inlined) browser
// build, renders each page to a 2x BGRA bitmap, swaps to RGBA for the canvas,
// and encodes a PNG blob per page. Pure of any app/DB concerns; only touches
// the DOM canvas APIs, so it must run in the browser.

import { PDFiumLibrary } from "@hyzyla/pdfium/browser/base64";

export type RasterizedPage = {
  pageNumber: number;
  blob: Blob;
  sizeBytes: number;
};

/**
 * Rasterize every page of `file` to a PNG blob (1-based pageNumber). Throws a
 * descriptive Error if the page count exceeds `maxPages` or if parsing/render
 * fails. Scale 2.0 keeps quality high for the vision LLM.
 */
export async function rasterizePdfToPngBlobs(
  file: File,
  maxPages: number,
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
        throw new Error(
          `PDF exceeds maximum limit of ${maxPages} pages (has ${numPages}).`,
        );
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
        ctx.putImageData(
          new ImageData(new Uint8ClampedArray(data), width, height),
          0,
          0,
        );

        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
        if (!blob) throw new Error(`Failed to create blob for page ${i}`);

        pages.push({ pageNumber: i, blob, sizeBytes: blob.size });
      }
    } finally {
      pdfDoc.destroy();
    }
  } finally {
    library.destroy();
  }

  return pages;
}
