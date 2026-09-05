import katex from "katex";

export type SimulationLatexMarker = {
  source: string;
  display: "inline" | "block";
};

/**
 * A marker plus where it sits in the document. The direct-edit pipeline
 * (`simulation-patch.ts`) rewrites formulas in place, so it needs offsets, not
 * just the decoded LaTeX.
 */
export type SimulationLatexMatch = SimulationLatexMarker & {
  /** Index of the marker's `<span`. */
  start: number;
  /** Index just past the marker's `</span>`. */
  end: number;
  /** Range of the raw (still HTML-encoded) LaTeX inside the marker. */
  sourceStart: number;
  sourceEnd: number;
};

const LATEX_CLASS_RE =
  /<span\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bsim-latex\b[^"']*["'])/gi;

function markerRegex(): RegExp {
  return /<span\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bsim-latex\b[^"']*["'])([^>]*)>([\s\S]*?)<\/span>/gi;
}

function decodeCodePoint(raw: string, radix: number): string {
  const value = Number.parseInt(raw, radix);
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "�";
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => decodeCodePoint(hex, 16))
    .replace(/&#([0-9]+);/g, (_, decimal: string) =>
      decodeCodePoint(decimal, 10),
    )
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markerFromMatch(
  attributes: string,
  rawSource: string,
): SimulationLatexMarker | null {
  if (/<[^>]+>/.test(rawSource)) return null;
  const source = decodeHtmlEntities(rawSource.trim());
  if (!source || source.includes("$")) return null;
  const rawDisplay =
    attributes.match(/\bdata-display\s*=\s*["']([^"']+)["']/i)?.[1] ?? "inline";
  if (rawDisplay !== "inline" && rawDisplay !== "block") return null;
  return { source, display: rawDisplay };
}

/**
 * Every valid marker in document order, with source offsets. Invalid markers
 * are skipped here exactly as they are skipped by the renderer, so a marker's
 * position in this array is the same `data-sim-index` the editor sees.
 */
export function locateSimulationLatexMarkers(
  html: string,
): SimulationLatexMatch[] {
  const matches: SimulationLatexMatch[] = [];
  for (const match of html.matchAll(markerRegex())) {
    const marker = markerFromMatch(match[1], match[2]);
    if (!marker) continue;
    const start = match.index;
    const sourceStart =
      start + match[0].length - match[2].length - "</span>".length;
    matches.push({
      ...marker,
      start,
      end: start + match[0].length,
      sourceStart,
      sourceEnd: sourceStart + match[2].length,
    });
  }
  return matches;
}

export function extractSimulationLatexMarkers(
  html: string,
): SimulationLatexMarker[] {
  return locateSimulationLatexMarkers(html).map(({ source, display }) => ({
    source,
    display,
  }));
}

/** Serialize one formula back into the stored marker contract. */
export function buildSimulationLatexMarker(
  marker: SimulationLatexMarker,
): string {
  return `<span class="sim-latex" data-display="${marker.display}">${escapeHtml(marker.source)}</span>`;
}

/**
 * Reject LaTeX that cannot survive a round trip through the marker contract:
 * KaTeX must accept it, and it must stay free of HTML and `$` delimiters.
 * Returns a teacher-facing reason, or null when the formula is usable.
 */
export function checkSimulationLatex(
  source: string,
  display: "inline" | "block",
): string | null {
  const trimmed = source.trim();
  if (!trimmed) return "a formula cannot be empty";
  if (trimmed.includes("$")) return "write the formula without $ delimiters";
  if (/[<>]/.test(trimmed))
    return "a formula cannot contain < or > — use \\lt and \\gt";
  try {
    katex.renderToString(trimmed, {
      displayMode: display === "block",
      output: "mathml",
      throwOnError: true,
      trust: false,
    });
  } catch {
    return `KaTeX cannot parse this formula: ${trimmed}`;
  }
  return null;
}

/**
 * Validate the strict marker contract used by generated simulations. KaTeX is
 * run here as a parser so malformed formulas trigger the normal model repair
 * round instead of reaching students as raw text.
 */
export function validateSimulationLatex(html: string): string[] {
  const problems: string[] = [];
  const markerOpenings = Array.from(html.matchAll(LATEX_CLASS_RE)).length;
  const markers = extractSimulationLatexMarkers(html);

  if (markerOpenings < 1) {
    return [
      "document must display its formulas with at least one sim-latex marker",
    ];
  }
  if (markerOpenings !== markers.length) {
    problems.push(
      'every sim-latex marker must contain plain LaTeX and use data-display="inline" or "block"',
    );
  }
  if (markerOpenings > 8) {
    problems.push(
      `document has too many displayed formulas (found ${markerOpenings}, maximum 8)`,
    );
  }

  for (const marker of markers) {
    try {
      katex.renderToString(marker.source, {
        displayMode: marker.display === "block",
        output: "mathml",
        throwOnError: true,
        trust: false,
      });
    } catch {
      problems.push(`invalid LaTeX formula: ${marker.source}`);
    }
  }
  return problems;
}

/**
 * Replace validated LaTeX markers with self-contained MathML at serve time.
 *
 * With `annotate`, each rendered formula is wrapped in a span carrying the
 * original LaTeX and its position among the valid markers. The MathML that
 * KaTeX emits has no way back to the source a teacher would want to edit, so
 * the staff preview needs that round-trip anchor; student documents stay
 * byte-identical to the reviewed artifact.
 */
export function renderSimulationLatex(
  html: string,
  { annotate = false }: { annotate?: boolean } = {},
): string {
  let index = 0;
  return html.replace(
    markerRegex(),
    (original, attributes: string, rawSource: string) => {
      const marker = markerFromMatch(attributes, rawSource);
      if (!marker) return original;
      const position = index;
      index += 1;
      let rendered: string;
      try {
        rendered = katex.renderToString(marker.source, {
          displayMode: marker.display === "block",
          output: "mathml",
          throwOnError: true,
          trust: false,
        });
      } catch {
        rendered = `<span class="sim-formula-error">${escapeHtml(marker.source)}</span>`;
      }
      if (!annotate) return rendered;
      return (
        `<span class="sim-formula" data-sim-index="${position}" ` +
        `data-sim-display="${marker.display}" ` +
        `data-sim-latex="${escapeHtml(marker.source)}">${rendered}</span>`
      );
    },
  );
}
