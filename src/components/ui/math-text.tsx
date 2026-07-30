import katex from "katex";

export type MathSegment = {
  type: "text" | "inline" | "display";
  value: string;
};

/**
 * Split a string into plain-text, inline-math (`$...$`), and display-math
 * (`$$...$$`) segments. Pure and deterministic so it can be unit-tested
 * directly.
 *
 * Rules:
 * - `$$` is checked before `$`, so display math wins when both could match.
 * - An escaped `\$` is a literal dollar sign, never a delimiter.
 * - An unmatched/unterminated `$` or `$$` is NOT math: the delimiter and the
 *   remainder of the string are emitted as literal text.
 * - Empty math (e.g. `$$` or `$ $` with only whitespace inside) is treated as
 *   literal text, not a math segment.
 */
export function splitMathSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let buffer = "";
  let i = 0;

  const flushText = () => {
    if (buffer.length > 0) {
      segments.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    const char = text[i];

    // Escaped dollar -> literal `$`, consume both characters.
    if (char === "\\" && text[i + 1] === "$") {
      buffer += "$";
      i += 2;
      continue;
    }

    if (char === "$") {
      const isDisplay = text[i + 1] === "$";
      const delimiter = isDisplay ? "$$" : "$";
      const contentStart = i + delimiter.length;

      // Find the matching closing delimiter, skipping escaped `\$`.
      let j = contentStart;
      let closeIndex = -1;
      while (j < text.length) {
        if (text[j] === "\\" && text[j + 1] === "$") {
          j += 2;
          continue;
        }
        if (isDisplay) {
          if (text[j] === "$" && text[j + 1] === "$") {
            closeIndex = j;
            break;
          }
        } else if (text[j] === "$") {
          closeIndex = j;
          break;
        }
        j += 1;
      }

      if (closeIndex === -1) {
        // Unterminated: the delimiter and everything after it is literal text.
        buffer += text.slice(i);
        i = text.length;
        break;
      }

      const rawContent = text.slice(contentStart, closeIndex);
      // Empty / whitespace-only math is treated as literal text.
      if (rawContent.trim().length === 0) {
        buffer += text.slice(i, closeIndex + delimiter.length);
        i = closeIndex + delimiter.length;
        continue;
      }

      flushText();
      segments.push({
        type: isDisplay ? "display" : "inline",
        // Unescape `\$` inside math so authors can write a literal dollar.
        value: rawContent.replace(/\\\$/g, "$"),
      });
      i = closeIndex + delimiter.length;
      continue;
    }

    buffer += char;
    i += 1;
  }

  flushText();
  return segments;
}

/**
 * Render text that may contain LaTeX math delimited by `$...$` (inline) and
 * `$$...$$` (display). Renders synchronously via `katex.renderToString`, so it
 * works in both Server and Client Components (no `"use client"`).
 */
export function MathText({ text, className }: { text: string; className?: string }) {
  // Fast path: plain text with no math is emitted verbatim, guaranteeing
  // pixel-identical output for existing plain-text questions.
  if (!text.includes("$")) {
    return <span className={className}>{text}</span>;
  }

  const segments = splitMathSegments(text);

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === "text") {
          return <span key={index}>{segment.value}</span>;
        }
        const html = katex.renderToString(segment.value, {
          throwOnError: false,
          displayMode: segment.type === "display",
          // Explicit, even though it is KaTeX's default: this output goes
          // straight into dangerouslySetInnerHTML, and `trust` is what keeps
          // \href/\url/\includegraphics/\htmlClass from turning question text
          // (teacher- and AI-authored) into arbitrary markup. Mirrors
          // src/lib/simulation-math.ts.
          trust: false,
        });
        return <span key={index} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </span>
  );
}
