import katex from "katex";
import { splitMathSegments, type MathSegment } from "@/lib/math-segments";

export function MathText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
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
