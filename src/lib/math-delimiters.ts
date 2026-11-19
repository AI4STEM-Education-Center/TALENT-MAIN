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

  // Code, links and other literal spans come from a parse WITHOUT math: that
  // is how the renderer sees the text once currency `$` is escaped. (With math
  // on, "$5 … `echo $10`" lets the dollars swallow the code span.) The
  // math-aware parse only contributes `$$` blocks, which may contain blank
  // lines and so can't be recognised without it.
  const blocked = collect(MATH_PARSER.parse(markdown), (node) =>
    node.type === "math" ? [span(node)] : null,
  );
  const prose = collect(PROSE_PARSER.parse(markdown), (node) =>
    PROSE_BLOCKS.has(node.type)
      ? subtract([span(node)], [...literalSpans(node), ...blocked])
      : null,
  ).sort((a, b) => a[0] - b[0]);

  let out = "";
  let last = 0;
  for (const [start, end] of prose) {
    if (start < last || end <= start) continue;
    const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
    out += markdown.slice(last, start);
    out += rewriteText(
      markdown.slice(start, end),
      markdown.slice(lineStart, start),
    );
    last = end;
  }
  return out + markdown.slice(last);
}

const PROSE_PARSER = unified().use(remarkParse).use(remarkGfm);
const MATH_PARSER = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
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
      // A bare GFM URL stays prose, so a `$…$` wrapped around it still pairs.
      if (labelEnd === end && labelEnd > start) return;
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

/**
 * `lead` is the source from the start of the line up to this segment: the
 * container markers (`> `, `- `) or, mid-line, the text before it. It is used
 * only to recognise a `\[ … \]` standing on its own line(s) and to repeat the
 * container prefix on the lines a display block adds.
 */
function rewriteText(text: string, lead: string): string {
  const converted = convertDisplay(text, lead)
    // \( … \) on one line → $ … $
    .replace(/\\\(([^\n]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`);
  return escapeNonMathDollars(converted);
}

// Nothing but container markers (blockquote `>`, list bullets or numbers).
const CONTAINER_PREFIX =
  /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*$/;
const QUOTE_MARKERS = /^(?:[ \t]*>)*[ \t]*/;

/** A list marker becomes spaces on following lines; `>` repeats. */
function continuation(prefix: string): string {
  return prefix.replace(/[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])/g, (m) =>
    " ".repeat(m.length),
  );
}

function convertDisplay(text: string, lead: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("\\[", i);
    const close = open === -1 ? -1 : text.indexOf("\\]", open + 2);
    if (close === -1) break;
    out += text.slice(i, open);
    const lineStart = text.lastIndexOf("\n", open - 1) + 1;
    const prefix = (lineStart === 0 ? lead : "") + text.slice(lineStart, open);
    const lineEnd = text.indexOf("\n", close + 2);
    const after = text.slice(close + 2, lineEnd === -1 ? text.length : lineEnd);
    const body = text.slice(open + 2, close);
    const lines = body
      .split("\n")
      .map((line, k) => (k === 0 ? line : line.replace(QUOTE_MARKERS, "")))
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (
      CONTAINER_PREFIX.test(prefix) &&
      (after.trim() === "" || body.includes("\n"))
    ) {
      // A display block on its own line(s): one line per formula line, each
      // carrying the container prefix so `>` quotes and lists survive.
      const cont = continuation(prefix);
      out += ["$$", ...lines.map((l) => cont + l), cont + "$$"].join("\n");
      // A closing fence must be alone on its line. Keep punctuation or prose
      // after a multiline formula outside the equation, in the same container.
      out += after.trim() === "" ? after : "\n" + cont + after.trimStart();
      i = close + 2 + after.length;
    } else {
      // Inside a sentence → $$ … $$ (rendered inline by remark-math).
      // Fold source line breaks so a closing $$ cannot become a new block.
      out += `$$${lines.join(" ")}$$`;
      i = close + 2;
    }
  }
  return out + text.slice(i);
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
