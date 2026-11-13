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
});
