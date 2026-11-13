/**
 * Prepares model-written Markdown for remark-math.
 *
 * Models write LaTeX with `$…$` / `$$…$$` or with `\(…\)` / `\[…\]`. remark-math
 * only understands dollars, and Markdown treats `\(` as an escaped parenthesis,
 * so `\(\vec a = \vec F/m\)` would reach the student as "(\vec a = \vec F/m)".
 * This rewrites the backslash delimiters to dollars and escapes any `$` that
 * cannot be math under Pandoc's rule (so "$5 and $10" stays currency).
 *
 * Code (fenced with ``` or ~~~ of any length, indented, or inline) and link
 * destinations are never touched.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("$") && !/\\[([]/.test(markdown)) return markdown;

  const lines = markdown.split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let fence: { char: string; length: number } | null = null;
  // The last non-blank line outside code was a list item or continuation,
  // so an indented line belongs to the list rather than being code.
  let inList = false;
  let prevBlank = true;

  const flush = () => {
    if (paragraph.length > 0) out.push(rewriteParagraph(paragraph.join("\n")));
    paragraph = [];
  };

  for (const line of lines) {
    if (fence) {
      out.push(line);
      const close = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length
      )
        fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      flush();
      fence = { char: open[1][0], length: open[1].length };
      out.push(line);
      prevBlank = false;
      continue;
    }
    if (line.trim() === "") {
      flush();
      out.push(line);
      prevBlank = true;
      continue;
    }
    const indented = /^( {4}|\t)/.test(line);
    if (indented && prevBlank && !inList) {
      // Indented code block line (and its following indented lines).
      flush();
      out.push(line);
      continue;
    }
    if (indented && !prevBlank && out.length > 0 && paragraph.length === 0) {
      // Continuation of an indented code block.
      const last = out[out.length - 1];
      if (/^( {4}|\t)/.test(last) && !inList) {
        out.push(line);
        continue;
      }
    }
    if (!indented) inList = /^\s{0,3}([-*+]|\d+[.)])\s/.test(line);
    paragraph.push(line);
    prevBlank = false;
  }
  flush();
  return out.join("\n");
}

// Inline code (matching complete backtick runs), link/image destinations,
// single-line reference definitions, autolinks. Requiring a complete opening
// run avoids retrying every suffix/length of an unmatched run (cubic work).
const PROTECTED =
  /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\)))?\)|^ {0,3}\[(?:\\.|[^\]\\\n])+\]:[^\n]*|<[a-zA-Z][a-zA-Z0-9+.-]*:[^>\s]*>/gm;

function rewriteParagraph(text: string): string {
  let result = "";
  let last = 0;
  for (const m of text.matchAll(PROTECTED)) {
    result += rewriteText(text.slice(last, m.index));
    result += m[0];
    last = m.index + m[0].length;
  }
  return result + rewriteText(text.slice(last));
}

function rewriteText(text: string): string {
  if (!text) return text;
  const converted = text
    // \[ … \] filling its own line(s) → a display block.
    .replace(
      /^([ \t]*)\\\[([\s\S]+?)\\\][ \t]*$/gm,
      (_, indent: string, body: string) =>
        `${indent}$$\n${indent}${body.trim()}\n${indent}$$`,
    )
    // \[ … \] inside a sentence → $$ … $$ (rendered inline by remark-math).
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `$$${body.trim()}$$`)
    // \( … \) on one line → $ … $
    .replace(/\\\(([^\n]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`);
  return escapeNonMathDollars(converted);
}

/**
 * Pandoc's rule for single-dollar math: the opening `$` must be followed by a
 * non-space, and the NEXT `$` must be preceded by a non-space and not followed
 * by a digit. Any `$` that can't open such a pair is escaped as currency.
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
        out += text.slice(i, close + 2);
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
      out += text.slice(i, close + 1);
      i = close + 1;
    } else {
      out += "\\$";
      i += 1;
    }
  }
  return out;
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
