import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * On-demand PDF rendering for one consent signature. Deliberately the ONLY
 * place a consent PDF is ever produced — the single-record admin preview, the
 * bulk admin export, and the post-signature confirmation email all call this
 * same function and never persist the result beyond the response/attachment
 * that needed it (see docs/plans/consent-compliance-plan.md §4/§8).
 *
 * Uses pdf-lib (pure JS, no headless-browser/Chromium dependency) rather than
 * an HTML-to-PDF renderer: this won't reproduce the original uploaded
 * template's exact pixel layout, but it keeps the footprint small on a
 * resource-constrained deployment, which matters here because generation can
 * run dozens of times back-to-back during a bulk export.
 */

export interface ConsentRecordForPdf {
  role: string;
  decision: string;
  interviewRecordingConsent: boolean | null;
  initialsStrokeData: string | null;
  signatureTypedName: string;
  signatureStrokeData: string | null;
  signedAt: Date;
  ipAddress: string;
  userAgent: string;
  deviceType: string;
  signerNameSnapshot: string;
  signerEmailSnapshot: string;
}

export interface ConsentFormVersionForPdf {
  title: string;
  version: string;
  role: string;
  bodyHtml: string;
}

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BODY_SIZE = 10;
const LABEL_SIZE = 10;
const HEADING_SIZE = 15;
const LINE_GAP = 4;

/**
 * StandardFonts use WinAnsiEncoding, which pdf-lib rejects a handful of
 * common "smart" punctuation characters under (curly quotes, em/en dashes,
 * bullets, non-breaking spaces) that show up in pasted legal text. Swapping
 * them for plain ASCII keeps rendering from throwing on real-world input.
 */
function sanitizeForPdf(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/•/g, "*")
    .replace(/ /g, " ")
    .replace(/…/g, "...")
    .replace(/[^\x00-\x7E\n]/g, "?");
}

/** Strip the stored HTML body down to plain paragraphs for the PDF. */
export function htmlToPlainTextLines(html: string): string[] {
  const withBreaks = html
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");
  const stripped = withBreaks.replace(/<[^>]+>/g, "");
  const decoded = stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'");

  const lines = decoded
    .split("\n")
    .map((line) => sanitizeForPdf(line).replace(/[ \t]+/g, " ").trim());

  // Collapse runs of blank lines to one, so paragraph spacing stays readable.
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === "" && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(line);
  }
  while (collapsed[0] === "") collapsed.shift();
  while (collapsed[collapsed.length - 1] === "") collapsed.pop();
  return collapsed;
}

function wrapLine(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (text === "") return [""];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface Cursor {
  doc: PDFDocument;
  font: PDFFont;
  boldFont: PDFFont;
  page: PDFPage;
  y: number;
}

function newPage(cursor: Cursor): void {
  cursor.page = cursor.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cursor.y = PAGE_HEIGHT - MARGIN;
}

function ensureSpace(cursor: Cursor, needed: number): void {
  if (cursor.y - needed < MARGIN) newPage(cursor);
}

function drawLine(cursor: Cursor, text: string, opts: { size: number; bold?: boolean; gap?: number } ): void {
  const font = opts.bold ? cursor.boldFont : cursor.font;
  ensureSpace(cursor, opts.size + (opts.gap ?? LINE_GAP));
  cursor.page.drawText(text, { x: MARGIN, y: cursor.y - opts.size, size: opts.size, font, color: rgb(0.1, 0.1, 0.1) });
  cursor.y -= opts.size + (opts.gap ?? LINE_GAP);
}

function drawParagraph(cursor: Cursor, text: string, opts: { size?: number; bold?: boolean } = {}): void {
  const size = opts.size ?? BODY_SIZE;
  const font = opts.bold ? cursor.boldFont : cursor.font;
  const wrapped = wrapLine(text, font, size, CONTENT_WIDTH);
  for (const line of wrapped) drawLine(cursor, line, { size, bold: opts.bold });
}

function drawSpacer(cursor: Cursor, height: number): void {
  ensureSpace(cursor, height);
  cursor.y -= height;
}

interface StrokePoint {
  x?: number;
  y?: number;
}
interface StrokeGroup {
  points?: StrokePoint[];
}

/**
 * Render hand-drawn stroke data (signature_pad's `toData()` shape — an array
 * of point groups) into a fixed box on the page, scaled to fit while
 * preserving aspect ratio. No-ops silently on malformed/empty data so a
 * corrupt or absent drawing never breaks PDF generation.
 */
function drawStrokes(
  cursor: Cursor,
  raw: string | null,
  box: { x: number; y: number; width: number; height: number }
): boolean {
  if (!raw) return false;
  let groups: StrokeGroup[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return false;
    groups = parsed as StrokeGroup[];
  } catch {
    return false;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of groups) {
    for (const p of g.points ?? []) {
      if (typeof p.x === "number" && typeof p.y === "number") {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX || maxY <= minY) return false;

  const srcW = maxX - minX;
  const srcH = maxY - minY;
  const scale = Math.min(box.width / srcW, box.height / srcH) * 0.9;
  const offsetX = box.x + (box.width - srcW * scale) / 2;
  const offsetY = box.y + (box.height - srcH * scale) / 2;

  let drewAny = false;
  for (const g of groups) {
    const points = g.points ?? [];
    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1];
      const p1 = points[i];
      if (
        typeof p0.x !== "number" || typeof p0.y !== "number" ||
        typeof p1.x !== "number" || typeof p1.y !== "number"
      ) {
        continue;
      }
      cursor.page.drawLine({
        start: { x: offsetX + (p0.x - minX) * scale, y: offsetY + (srcH - (p0.y - minY)) * scale },
        end: { x: offsetX + (p1.x - minX) * scale, y: offsetY + (srcH - (p1.y - minY)) * scale },
        thickness: 1.2,
        color: rgb(0.1, 0.1, 0.5),
      });
      drewAny = true;
    }
  }
  return drewAny;
}

function formatTimestamp(date: Date): string {
  return `${date.toISOString()} (UTC)`;
}

export async function renderConsentPdf(
  record: ConsentRecordForPdf,
  formVersion: ConsentFormVersionForPdf
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const [font, boldFont] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
  ]);
  const cursor: Cursor = { doc, font, boldFont, page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: PAGE_HEIGHT - MARGIN };

  drawParagraph(cursor, sanitizeForPdf(formVersion.title), { size: HEADING_SIZE, bold: true });
  drawParagraph(cursor, `Form version: ${formVersion.version} · Role: ${formVersion.role}`, { size: 9 });
  drawSpacer(cursor, 10);

  drawParagraph(cursor, "Signature record", { size: 12, bold: true });
  drawSpacer(cursor, 4);
  const fields: [string, string][] = [
    ["Name", sanitizeForPdf(record.signerNameSnapshot)],
    ["Email", sanitizeForPdf(record.signerEmailSnapshot)],
    ["Decision", record.decision === "AGREE" ? "Yes, I agree to participate" : "No, I do not agree to participate"],
    ["Signed at", formatTimestamp(record.signedAt)],
    ["IP address", record.ipAddress],
    ["Device type", record.deviceType],
    [
      "Interview recording consent",
      record.interviewRecordingConsent === true
        ? "Yes"
        : record.interviewRecordingConsent === false
          ? "No"
          : "Not applicable",
    ],
  ];
  for (const [label, value] of fields) {
    drawParagraph(cursor, `${label}: ${value}`, { size: LABEL_SIZE });
  }
  drawSpacer(cursor, 8);

  drawParagraph(cursor, "Digital signature (typed name):", { size: LABEL_SIZE, bold: true });
  drawParagraph(cursor, sanitizeForPdf(record.signatureTypedName), { size: 16 });
  drawSpacer(cursor, 6);

  const signatureBoxHeight = 70;
  if (record.signatureStrokeData) {
    ensureSpace(cursor, signatureBoxHeight + 16);
    const box = { x: MARGIN, y: cursor.y - signatureBoxHeight, width: 220, height: signatureBoxHeight };
    const drew = drawStrokes(cursor, record.signatureStrokeData, box);
    if (drew) {
      cursor.page.drawText("(hand-drawn signature)", {
        x: MARGIN, y: cursor.y - signatureBoxHeight - 12, size: 8, font, color: rgb(0.4, 0.4, 0.4),
      });
    }
    cursor.y -= signatureBoxHeight + 16;
  }

  if (record.interviewRecordingConsent && record.initialsStrokeData) {
    ensureSpace(cursor, signatureBoxHeight + 16);
    drawParagraph(cursor, "Interview-recording initials:", { size: LABEL_SIZE, bold: true });
    const box = { x: MARGIN, y: cursor.y - signatureBoxHeight, width: 100, height: signatureBoxHeight };
    drawStrokes(cursor, record.initialsStrokeData, box);
    cursor.y -= signatureBoxHeight + 8;
  }

  drawSpacer(cursor, 16);
  newPage(cursor);
  drawParagraph(cursor, "Full form text", { size: 12, bold: true });
  drawSpacer(cursor, 6);
  for (const line of htmlToPlainTextLines(formVersion.bodyHtml)) {
    if (line === "") {
      drawSpacer(cursor, BODY_SIZE);
    } else {
      drawParagraph(cursor, line, { size: BODY_SIZE });
    }
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
