import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import {
  PDFiumDocument,
  PDFiumLibrary,
  PDFiumPage,
} from "@hyzyla/pdfium/inline";
import { extractPdfText } from "@/lib/pdf-text-client";
import { rasterizePdfToImageBlobs } from "@/lib/pdf-rasterize-client";

// Real PDF bytes and real PDFium WASM: only the browser canvas encoder is
// substituted in Node. Browser QA additionally checks actual encoded pixels.
async function fixture(count = 2): Promise<File> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const page = pdf.addPage([100, 100]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 50,
      height: 100,
      color: rgb(1, 0, 0),
    });
    page.drawRectangle({
      x: 50,
      y: 0,
      width: 50,
      height: 100,
      color: rgb(0, 0, 1),
    });
    page.drawText(`Page ${i + 1}`, { x: 5, y: 80, size: 10, font });
  }
  return new File([new Uint8Array(await pdf.save())], "colors.pdf", {
    type: "application/pdf",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function canvasStub(fail = false) {
  const pixels: Uint8ClampedArray[] = [];
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        putImageData: (image: ImageData) => pixels.push(image.data),
      }),
      toBlob: (callback: BlobCallback) =>
        callback(fail ? null : new Blob(["encoded"], { type: "image/png" })),
    }),
  });
  return pixels;
}

describe("PDFium v3 client integration", () => {
  it("extracts real multi-page text and closes each page before opening the next", async () => {
    const close = vi.spyOn(PDFiumPage.prototype, "close");
    const getPage = vi.spyOn(PDFiumDocument.prototype, "getPage");
    expect(await extractPdfText(await fixture())).toBe("Page 1\nPage 2");
    expect(close).toHaveBeenCalledTimes(2);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(
      getPage.mock.invocationCallOrder[1],
    );
  });

  it("passes real RGBA pixels to canvas without swapping red and blue", async () => {
    const pixels = canvasStub();
    const close = vi.spyOn(PDFiumPage.prototype, "close");
    const getPage = vi.spyOn(PDFiumDocument.prototype, "getPage");
    const pages = await rasterizePdfToImageBlobs(
      await fixture(),
      2,
      "image/png",
    );
    expect(pages.map((p) => [p.pageNumber, p.mimeType, p.sizeBytes])).toEqual([
      [1, "image/png", 7],
      [2, "image/png", 7],
    ]);
    for (const data of pixels) {
      expect(
        Array.from(data.slice((100 * 200 + 25) * 4, (100 * 200 + 25) * 4 + 4)),
      ).toEqual([255, 0, 0, 255]);
      expect(
        Array.from(
          data.slice((100 * 200 + 175) * 4, (100 * 200 + 175) * 4 + 4),
        ),
      ).toEqual([0, 0, 255, 255]);
    }
    expect(close).toHaveBeenCalledTimes(2);
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(
      getPage.mock.invocationCallOrder[1],
    );
  });

  it("closes the page, document and library when encoding fails", async () => {
    canvasStub(true);
    const close = vi.spyOn(PDFiumPage.prototype, "close");
    const destroyDoc = vi.spyOn(PDFiumDocument.prototype, "destroy");
    const destroyLib = vi.spyOn(PDFiumLibrary.prototype, "destroy");
    await expect(rasterizePdfToImageBlobs(await fixture(), 2)).rejects.toThrow(
      "Failed to create blob for page 1",
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);
    expect(destroyLib).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized documents before opening pages", async () => {
    const getPage = vi.spyOn(PDFiumDocument.prototype, "getPage");
    const destroy = vi.spyOn(PDFiumDocument.prototype, "destroy");
    await expect(rasterizePdfToImageBlobs(await fixture(), 1)).rejects.toThrow(
      "maximum limit of 1 pages (has 2)",
    );
    expect(getPage).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("preserves the 60-page text extraction limit", async () => {
    const close = vi.spyOn(PDFiumPage.prototype, "close");
    const text = await extractPdfText(await fixture(61));
    expect(text.split("\n")).toHaveLength(60);
    expect(text).toContain("Page 60");
    expect(text).not.toContain("Page 61");
    expect(close).toHaveBeenCalledTimes(60);
  });

  it("rejects invalid PDF bytes in both helpers and destroys their libraries", async () => {
    const destroy = vi.spyOn(PDFiumLibrary.prototype, "destroy");
    const file = new File(["not a PDF"], "invalid.pdf");
    await expect(extractPdfText(file)).rejects.toThrow();
    await expect(rasterizePdfToImageBlobs(file, 2)).rejects.toThrow();
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
