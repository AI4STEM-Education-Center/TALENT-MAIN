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

  it("renders an escaped dollar inside math without a KaTeX error", () => {
    const html = render("cost $a\\$b$ here");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("katex-error");
  });

  it("renders blockquote display math inside the quote", () => {
    const html = render("> \\[\n> x^2\n> \\]");
    expect(html).toMatch(
      /<blockquote>[\s\S]*katex-display[\s\S]*<\/blockquote>/,
    );
    expect(html).not.toContain("katex-error");
  });

  it("keeps currency out of inline code", () => {
    const html = render("Pay $5, then run `echo $10`.");
    expect(html).toContain("<code>echo $10</code>");
    expect(html).not.toContain("katex");
  });

  it("renders multiline display math followed by punctuation or prose", () => {
    const container = document.createElement("div");
    container.innerHTML = render(
      "> \\[\n> x^2\n> \\] to solve.\n\n- \\[\n  F=ma\n  \\].\n- Next",
    );
    expect(container.querySelectorAll(".katex-display")).toHaveLength(2);
    expect(container.querySelector("blockquote p")?.textContent).toBe(
      "to solve.",
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelectorAll("li")[1]?.textContent).toBe("Next");
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.textContent).not.toContain("\\]");
  });

  it("renders multiline math embedded in a quoted sentence", () => {
    const container = document.createElement("div");
    container.innerHTML = render("> Thus \\[\n> F=ma\n> \\] holds.");
    expect(container.querySelector("blockquote .katex")).not.toBeNull();
    expect(container.querySelector("annotation")?.textContent).toBe("F=ma");
    expect(container.querySelector("blockquote")?.textContent).toContain(
      "holds.",
    );
    expect(container.querySelector(".katex-error")).toBeNull();
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
