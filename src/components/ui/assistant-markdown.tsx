import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters } from "@/lib/math-delimiters";

const REMARK_PLUGINS = [remarkGfm, remarkMath];
// throwOnError=false: a malformed formula renders as red source text instead
// of breaking the whole message.
const REHYPE_PLUGINS: Parameters<typeof ReactMarkdown>[0]["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];

/**
 * Markdown for model-written text (assistant replies, result summaries):
 * GitHub-flavoured Markdown plus KaTeX math in `$…$`, `$$…$$`, `\(…\)` and
 * `\[…\]`. KaTeX's stylesheet is loaded globally in the root layout.
 */
export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
    >
      {normalizeMathDelimiters(children)}
    </ReactMarkdown>
  );
}
