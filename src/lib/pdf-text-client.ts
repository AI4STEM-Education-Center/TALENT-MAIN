// Browser-only PDF text extraction for the admin survey upload, using the same
// WASM-inlined pdfium build as pdf-rasterize-client.ts. Loaded on demand so the
// admin survey page doesn't ship pdfium until a file is actually chosen.

const MAX_PAGES = 60;

export async function extractPdfText(file: File): Promise<string> {
  const { PDFiumLibrary } = await import("@hyzyla/pdfium/inline");
  const library = await PDFiumLibrary.init({ disableBase64Warning: true });
  try {
    const doc = await library.loadDocument(
      new Uint8Array(await file.arrayBuffer()),
    );
    try {
      const pages: string[] = [];
      const count = Math.min(doc.getPageCount(), MAX_PAGES);
      for (let i = 0; i < count; i++) {
        const page = doc.getPage(i);
        try {
          pages.push(page.getText());
        } finally {
          page.close();
        }
      }
      return pages.join("\n");
    } finally {
      doc.destroy();
    }
  } finally {
    library.destroy();
  }
}
