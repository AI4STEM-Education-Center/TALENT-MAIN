import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Nodes, Root } from "mdast";

/**
 * Prepares model-written Markdown for remark-math.
 *
 * Models write LaTeX with `$…$` / `$$…$$` or with `\(…\)` / `\[…\]`. remark-math
 * only understands dollars, and Markdown treats `\(` as an escaped parenthesis,
 * so `\(\vec a = \vec F/m\)` would reach the student as "(\vec a = \vec F/m)".
 * This rewrites the backslash delimiters to dollars and escapes any `$` that
 * cannot be math under Pandoc's rule (so "$5 and $10" stays currency).
 *
 * Where to rewrite is decided by the same Markdown parser the renderer uses:
 * only the prose of paragraphs, headings and table cells is touched. Code of
 * any kind, link and image destinations, titles and alt text, definitions,
 * raw HTML and `$$` math blocks are left byte-for-byte as written.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("$") && !/\\[([]/.test(markdown)) return markdown;

  // Parse exactly as the renderer will (GFM + math). `$$` blocks are left
  // alone; inline math nodes count as prose so the currency rule below still
  // decides whether a "$5 … $10" pair is really math.
  const tree = PARSER.parse(markdown);
  const blocked = collect(tree, (node) =>
    node.type === "math" ? [span(node)] : null,
  );
  const prose = collect(tree, (node) =>
    PROSE_BLOCKS.has(node.type)
      ? subtract([span(node)], [...literalSpans(node), ...blocked])
      : null,
  ).sort((a, b) => a[0] - b[0]);

  let out = "";
  let last = 0;
  for (const [start, end] of prose) {
    if (start < last || end <= start) continue;
    const atLineStart = start === 0 || markdown[start - 1] === "\n";
    out += markdown.slice(last, start);
    out += rewriteText(markdown.slice(start, end), atLineStart);
    last = end;
  }
  return out + markdown.slice(last);
}

const PARSER = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const PROSE_BLOCKS = new Set(["paragraph", "heading", "tableCell"]);
// Inline nodes whose whole source is literal.
const OPAQUE_INLINE = new Set([
  "inlineCode",
  "image",
  "imageReference",
  "html",
  "footnoteReference",
]);

type Span = [number, number];

function span(node: Nodes): Span {
  return [node.position?.start.offset ?? 0, node.position?.end.offset ?? 0];
}

/** Walk the tree; a visitor that returns spans stops descent into that node. */
function collect(root: Root, visit: (node: Nodes) => Span[] | null): Span[] {
  const found: Span[] = [];
  const walk = (node: Nodes) => {
    const spans = visit(node);
    if (spans) {
      found.push(...spans);
      return;
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(root);
  return found;
}

/** Literal parts inside a prose block: code, images, HTML, link targets. */
function literalSpans(block: Nodes): Span[] {
  const spans: Span[] = [];
  const walk = (node: Nodes) => {
    if (OPAQUE_INLINE.has(node.type)) {
      spans.push(span(node));
      return;
    }
    if (node.type === "link" || node.type === "linkReference") {
      // The label stays prose; whatever follows it — `](url "title")` or
      // `][ref]` — is literal. Autolinks (`<url>`, bare URLs) have no
      // separate label, so the whole link is literal.
      const [start, end] = span(node);
      const kids = node.children;
      const labelEnd = kids.length ? span(kids[kids.length - 1])[1] : start;
      if (end - labelEnd <= 1 || labelEnd <= start) {
        spans.push([start, end]);
        return;
      }
      spans.push([labelEnd, end]);
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(block);
  return spans;
}

function subtract(spans: Span[], holes: Span[]): Span[] {
  let result = spans;
  for (const [hs, he] of holes) {
    result = result.flatMap(([s, e]): Span[] => {
      if (he <= s || hs >= e) return [[s, e]];
      const parts: Span[] = [];
      if (hs > s) parts.push([s, hs]);
      if (he < e) parts.push([he, e]);
      return parts;
    });
  }
  return result;
}

function rewriteText(text: string, atLineStart: boolean): string {
  // A sentinel stops `^` matching mid-line when this prose segment starts
  // after a list marker, a link target or an inline code span.
  const lead = atLineStart ? "" : "\u0000";
  const converted = (lead + text)
    // \[ … \] filling its own line(s) → a display block.
    .replace(
      /^([ \t]*)\\\[([\s\S]+?)\\\][ \t]*$/gm,
      (_, indent: string, body: string) =>
        `${indent}$$\n${indent}${body.trim()}\n${indent}$$`,
    )
    // \[ … \] inside a sentence → $$ … $$ (rendered inline by remark-math).
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `$$${body.trim()}$$`)
    // \( … \) on one line → $ … $
    .replace(/\\\(([^\n]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`)
    .slice(lead.length);
  return escapeNonMathDollars(converted);
}

/**
 * Pandoc's rule for single-dollar math: the opening `$` must be followed by a
 * non-space, and the NEXT `$` must be preceded by a non-space and not followed
 * by a digit. Any `$` that can't open such a pair is escaped as currency.
 * Inside a kept math span, `\$` becomes `{\char36}`: remark-math would
 * otherwise end the span at the escaped dollar.
 */
function escapeNonMathDollars(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    if (text[i + 1] === "$") {
      const close = findUnescaped(text, "$$", i + 2);
      if (close !== -1 && text.slice(i + 2, close).trim()) {
        out += "$$" + mathBody(text.slice(i + 2, close)) + "$$";
        i = close + 2;
      } else {
        out += "\\$\\$";
        i += 2;
      }
      continue;
    }
    const next = text[i + 1];
    const close = findUnescaped(text, "$", i + 1);
    const opens = next !== undefined && !/\s/.test(next);
    const closes =
      close !== -1 &&
      !/\s/.test(text[close - 1]) &&
      !/[0-9]/.test(text[close + 1] ?? "");
    if (opens && closes) {
      out += "$" + mathBody(text.slice(i + 1, close)) + "$";
      i = close + 1;
    } else {
      out += "\\$";
      i += 1;
    }
  }
  return out;
}

function mathBody(body: string): string {
  return body.replace(/\\\$/g, "{\\char36}");
}

function findUnescaped(text: string, token: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    if (text[j] === "\\") {
      j += 1;
      continue;
    }
    if (text.startsWith(token, j)) return j;
  }
  return -1;
}
