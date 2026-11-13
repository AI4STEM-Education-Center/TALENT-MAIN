/**
 * Models write LaTeX with either `$…$` / `$$…$$` or the `\(…\)` / `\[…\]`
 * delimiters. remark-math only understands dollars, and Markdown treats `\(`
 * as an escaped parenthesis, so `\(\vec a = \vec F/m\)` would reach the
 * student as "(\vec a = \vec F/m)". This rewrites the backslash delimiters to
 * dollar delimiters, leaving fenced code blocks and inline code untouched.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;

  // Split on fenced blocks and inline code spans; odd indexes are code.
  const parts = markdown.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return parts.map((part, i) => (i % 2 === 1 ? part : rewrite(part))).join("");
}

function rewrite(text: string): string {
  return (
    text
      // Display math: \[ … \] (may span lines) → $$ … $$
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `$$${body.trim()}$$`)
      // Inline math: \( … \) on one line → $ … $
      .replace(/\\\(([^\n]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`)
  );
}
