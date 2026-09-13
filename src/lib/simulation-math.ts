import katex from "katex";

export type SimulationLatexMarker = {
  source: string;
  display: "inline" | "block";
};

const LATEX_CLASS_RE = /<span\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bsim-latex\b[^"']*["'])/gi;

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
    .replace(/&#([0-9]+);/g, (_, decimal: string) => decodeCodePoint(decimal, 10))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markerFromMatch(attributes: string, rawSource: string): SimulationLatexMarker | null {
  if (/<[^>]+>/.test(rawSource)) return null;
  const source = decodeHtmlEntities(rawSource.trim());
  if (!source || source.includes("$")) return null;
  const rawDisplay = attributes.match(/\bdata-display\s*=\s*["']([^"']+)["']/i)?.[1] ?? "inline";
  if (rawDisplay !== "inline" && rawDisplay !== "block") return null;
  return { source, display: rawDisplay };
}

export function extractSimulationLatexMarkers(html: string): SimulationLatexMarker[] {
  const markers: SimulationLatexMarker[] = [];
  for (const match of html.matchAll(markerRegex())) {
    const marker = markerFromMatch(match[1], match[2]);
    if (marker) markers.push(marker);
  }
  return markers;
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
    return ["document must display its formulas with at least one sim-latex marker"];
  }
  if (markerOpenings !== markers.length) {
    problems.push("every sim-latex marker must contain plain LaTeX and use data-display=\"inline\" or \"block\"");
  }
  if (markerOpenings > 8) {
    problems.push(`document has too many displayed formulas (found ${markerOpenings}, maximum 8)`);
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

/** Replace validated LaTeX markers with self-contained MathML at serve time. */
export function renderSimulationLatex(html: string): string {
  return html.replace(markerRegex(), (original, attributes: string, rawSource: string) => {
    const marker = markerFromMatch(attributes, rawSource);
    if (!marker) return original;
    try {
      return katex.renderToString(marker.source, {
        displayMode: marker.display === "block",
        output: "mathml",
        throwOnError: true,
        trust: false,
      });
    } catch {
      return `<span class="sim-formula-error">${escapeHtml(marker.source)}</span>`;
    }
  });
}
