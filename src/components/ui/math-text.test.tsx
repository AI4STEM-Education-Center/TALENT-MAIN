// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MathText } from "./math-text";
import { splitMathSegments } from "@/lib/math-segments";

describe("splitMathSegments", () => {
  it("returns a single text segment for plain text", () => {
    expect(splitMathSegments("hello world")).toEqual([
      { type: "text", value: "hello world" },
    ]);
  });

  it("returns nothing for an empty string", () => {
    expect(splitMathSegments("")).toEqual([]);
  });

  it("parses a single inline math segment", () => {
    expect(splitMathSegments("$x+1$")).toEqual([
      { type: "inline", value: "x+1" },
    ]);
  });

  it("parses a display math block (checks $$ before $)", () => {
    expect(splitMathSegments("$$x+1$$")).toEqual([
      { type: "display", value: "x+1" },
    ]);
  });

  it("parses mixed text, inline, and display segments", () => {
    expect(
      splitMathSegments("Solve $a^2$ then graph $$y = mx + b$$ today"),
    ).toEqual([
      { type: "text", value: "Solve " },
      { type: "inline", value: "a^2" },
      { type: "text", value: " then graph " },
      { type: "display", value: "y = mx + b" },
      { type: "text", value: " today" },
    ]);
  });

  it("treats escaped \\$ as a literal dollar in text", () => {
    expect(splitMathSegments("costs \\$5 today")).toEqual([
      { type: "text", value: "costs $5 today" },
    ]);
  });

  it("does not treat an escaped \\$ as a delimiter", () => {
    // The first $ opens math, but \$ is escaped inside, and the final $ closes.
    expect(splitMathSegments("price $a \\$ b$ end")).toEqual([
      { type: "text", value: "price " },
      { type: "inline", value: "a $ b" },
      { type: "text", value: " end" },
    ]);
  });

  it("treats an unmatched $ as literal text (delimiter + remainder)", () => {
    expect(splitMathSegments("cost is $5 for one")).toEqual([
      { type: "text", value: "cost is $5 for one" },
    ]);
  });

  it("treats an unterminated $$ as literal text", () => {
    expect(splitMathSegments("open $$x + 1")).toEqual([
      { type: "text", value: "open $$x + 1" },
    ]);
  });

  it("treats empty/whitespace-only math as literal text", () => {
    expect(splitMathSegments("a $ $ b")).toEqual([
      { type: "text", value: "a $ $ b" },
    ]);
    expect(splitMathSegments("a $$ $$ b")).toEqual([
      { type: "text", value: "a $$ $$ b" },
    ]);
  });

  it("handles adjacent math segments", () => {
    expect(splitMathSegments("$a$$b$")).toEqual([
      { type: "inline", value: "a" },
      { type: "inline", value: "b" },
    ]);
  });
});

describe("MathText", () => {
  it("fast path: emits exactly the input text in a span with the className", () => {
    const html = renderToStaticMarkup(
      <MathText text="just plain text" className="my-class" />,
    );
    expect(html).toBe('<span class="my-class">just plain text</span>');
  });

  it("renders inline math as katex markup", () => {
    const html = renderToStaticMarkup(<MathText text="$x+1$" />);
    expect(html).toContain("katex");
  });

  it("does not throw on malformed LaTeX and still produces output", () => {
    let html = "";
    expect(() => {
      html = renderToStaticMarkup(<MathText text="$\\frac{$" />);
    }).not.toThrow();
    expect(html.length).toBeGreaterThan(0);
  });

  it("renders display math with displayMode (katex-display class)", () => {
    const html = renderToStaticMarkup(<MathText text="$$x+1$$" />);
    expect(html).toContain("katex-display");
  });

  it("applies the className to the wrapper for math content", () => {
    const html = renderToStaticMarkup(
      <MathText text="value $x$" className="wrapper" />,
    );
    expect(html).toContain('class="wrapper"');
  });
});
