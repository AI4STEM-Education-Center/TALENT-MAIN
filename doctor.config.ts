/**
 * React Doctor configuration.
 *
 * Only rules where EVERY occurrence in this repository is a false positive or a
 * deliberate architectural decision are turned off here. Rules that misfire on
 * some sites but catch real defects on others stay enabled and are suppressed
 * per-occurrence with an inline `react-doctor-disable-next-line` comment, so the
 * rule keeps guarding new code. Security and correctness rules are never
 * disabled wholesale.
 *
 * Per-occurrence rejections and their evidence live in
 * `.react-doctor/false-positives.md`.
 */
export default {
  rules: {
    // Every picture in this app is a short-lived presigned S3/CloudFront URL, so
    // `next/image` cannot optimize it without remote-pattern config and would
    // break when the signature expires. `next.config.mjs` sets
    // `images: { unoptimized: true }` to make that explicit and to drop the
    // /_next/image endpoint, which is the only route that would hand bytes to
    // sharp -> libvips. All 17 sites already carry an eslint-disable plus a
    // rationale comment.
    "react-doctor/nextjs-no-img-element": "off",

    // The datasource is SQLite through better-sqlite3, which is a single-writer
    // database on one shared connection. The flagged loops are either inside a
    // `prisma.$transaction` (src/lib/quiz-access.ts, api/admin/concepts/import)
    // or CPU-bound rather than IO-bound (src/lib/pdf-rasterize-client.ts renders
    // PDFium pages; src/lib/consent-export.ts draws PDFs with pdf-lib and
    // documents inline why serial keeps peak memory flat). Promise.all would add
    // contention and memory pressure without reducing total work. Where genuine
    // IO fan-out exists the code already uses Promise.all.
    "react-doctor/async-await-in-loop": "off",

    // All six sites do `array.includes()` over a bounded collection: CSV header
    // columns (~6 entries) and pending chat attachments (capped at
    // `maxAttachments`). Converting to a Set costs readability for no measurable
    // gain at these sizes.
    "react-doctor/js-set-map-lookups": "off",

    // Rewriting `.filter().map()` as `.reduce()`/`for...of` saves one pass over
    // collections that are bounded (quiz questions, roster rows, exam results)
    // and reads worse. No measurement supports a bottleneck here, and the React
    // Doctor playbook treats unmeasured performance findings as hypotheses.
    // `js-flatmap-filter` stays enabled — `.flatMap()` is genuinely cleaner.
    "react-doctor/js-combine-iterations": "off",
  },
};
