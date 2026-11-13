// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown } from "./assistant-markdown";

const render = (md: string) =>
  renderToStaticMarkup(<AssistantMarkdown>{md}</AssistantMarkdown>);

describe("AssistantMarkdown", () => {
  it("renders \\( \\) inline math with KaTeX instead of raw source", () => {
    const html = render(
      "Newton's second law, \\(\\vec a=\\vec F_{\\text{net}}/m\\); so…",
    );
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("(\\vec a");
  });

  it("renders $ and $$ math", () => {
    const html = render("Inline $x^2$ and \\[F = ma\\]\n\n$$\nE = mc^2\n$$");
    expect(html.match(/class="katex"/g)?.length).toBe(3);
    // A fenced $$ block renders as display math.
    expect(html).toContain("katex-display");
  });

  it("keeps GitHub-flavoured markdown and bold", () => {
    const html = render("**net force**\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<strong>net force</strong>");
    expect(html).toContain("<table>");
  });

  it("renders currency as plain text, not math", () => {
    const html = render("Costs $5 and $10.");
    expect(html).not.toContain("katex");
    expect(html).toContain("Costs $5 and $10.");
  });

  it("renders a standalone \\[ \\] line as display math, even mid-paragraph", () => {
    const html = render("Use this:\n\\[F = ma\\]\nthen solve.");
    expect(html).toContain("katex-display");
    expect(html).toContain("then solve.");
  });

  it("renders display math with CRLF input and TeX line breaks", () => {
    const html = render(
      "before\r\n\\[\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\\]\r\nafter",
    );
    expect(html).toContain("katex-display");
    expect(html).not.toContain("katex-error");
    expect(html).toContain("after");
  });

  it("preserves reference URLs and link titles containing backslash delimiters", () => {
    const container = document.createElement("div");
    container.innerHTML = render(
      "[ref]\n\n[ref]: https://example.com/a\\(b\\)\n\n" +
        "[title](https://example.com 'say \\(x\\)')",
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/a(b)",
    );
    expect(container.querySelector("a[title]")?.getAttribute("title")).toBe(
      "say (x)",
    );
  });

  it("does not throw on malformed TeX", () => {
    expect(() => render("$\\frac{1}{$")).not.toThrow();
  });

  it("does not execute raw HTML or JavaScript links", () => {
    const container = document.createElement("div");
    container.innerHTML = render(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert%281%29)',
    );
    expect(container.querySelector("script, img, [onerror]")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("keeps KaTeX HTML and URL commands untrusted", () => {
    const container = document.createElement("div");
    container.innerHTML = render(
      "$\\href{javascript:alert(1)}{click}$ " +
        "$\\includegraphics{https://example.com/tracker.png}$ " +
        "$\\htmlStyle{background:url(https://example.com/tracker.png)}{x}$",
    );
    expect(container.querySelector("a, img")).toBeNull();
    expect(container.querySelector('[style*="background"]')).toBeNull();
  });
});
