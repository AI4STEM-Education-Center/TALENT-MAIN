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
