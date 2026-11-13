import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { normalizeMathDelimiters as n } from "./math-delimiters";

describe("normalizeMathDelimiters", () => {
  it("rewrites inline \\( \\) to $ $", () => {
    expect(
      n("In Newton's second law, \\(\\vec a=\\vec F_{\\text{net}}/m\\); so…"),
    ).toBe("In Newton's second law, $\\vec a=\\vec F_{\\text{net}}/m$; so…");
  });

  it("turns \\[ \\] on its own line(s) into a display block", () => {
    expect(n("Use\n\\[\nF = ma\n\\]\nthen")).toBe("Use\n$$\nF = ma\n$$\nthen");
    expect(n("\\[F=ma\\]")).toBe("$$\nF=ma\n$$");
  });

  it("keeps \\[ \\] inside a sentence inline", () => {
    expect(n("so \\[F=ma\\] holds")).toBe("so $$F=ma$$ holds");
  });

  it("leaves valid dollar math alone", () => {
    const s = "Already $x^2$ and $$y$$, plus (about 5).";
    expect(n(s)).toBe(s);
  });

  it("escapes currency so it never becomes math", () => {
    expect(n("Costs $5 and $10.")).toBe("Costs \\$5 and \\$10.");
    expect(n("$5 and $10 or $x$")).toBe("\\$5 and \\$10 or $x$");
    expect(n("Only $ 3 left")).toBe("Only \\$ 3 left");
    expect(n("already \\$5")).toBe("already \\$5");
  });

  it("does not touch inline code or backtick fences", () => {
    const s =
      "Run `echo \\(x\\) $5` or\n```\n\\[ raw \\] $5\n```\nthen \\(y\\)";
    expect(n(s)).toBe(
      "Run `echo \\(x\\) $5` or\n```\n\\[ raw \\] $5\n```\nthen $y$",
    );
  });

  it("protects tilde fences and longer backtick fences", () => {
    const tilde = "~~~\n\\(x\\) $5\n~~~";
    expect(n(tilde)).toBe(tilde);
    const longer = "````\n```\n\\(x\\)\n```\n````\n\\(y\\)";
    expect(n(longer)).toBe("````\n```\n\\(x\\)\n```\n````\n$y$");
  });

  it("protects indented code but not indented list content", () => {
    const code = "Text\n\n    \\(x\\) $5\n    more";
    expect(n(code)).toBe(code);
    expect(n("- item\n\n    \\(x\\)")).toBe("- item\n\n    $x$");
  });

  it("never rewrites link destinations or autolinks", () => {
    const link = "[reference](https://example.com/a\\(b\\)) and \\(c\\)";
    expect(n(link)).toBe("[reference](https://example.com/a\\(b\\)) and $c$");
    const auto = "<https://example.com/$5> costs $5";
    expect(n(auto)).toBe("<https://example.com/$5> costs \\$5");
  });

  it("keeps an unterminated \\( as literal text", () => {
    expect(n("a \\(b")).toBe("a \\(b");
  });

  it("protects all three Markdown link title delimiters", () => {
    for (const title of ['"say \\(x\\)"', "'say \\(x\\)'", "(say \\(x\\))"]) {
      const link = `[x](https://example.com ${title})`;
      expect(n(`${link} and \\(y\\)`)).toBe(`${link} and $y$`);
    }
  });

  it("preserves single-line reference destinations and titles", () => {
    const definition = '[x]: https://example.com/a\\(b\\) "Costs $5"';
    expect(n(`[x] and \\(y\\)\n\n${definition}`)).toBe(
      `[x] and $y$\n\n${definition}`,
    );
  });

  it("does not stall on very long unmatched backtick runs", () => {
    // Use a subprocess timeout: a synchronous regex cannot be interrupted by
    // Vitest's own timeout. This case took cubic time before the boundary fix.
    const modulePath = resolve("src/lib/math-delimiters.ts");
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { normalizeMathDelimiters as n } from ${JSON.stringify(modulePath)};
         const input = 'text ' + String.fromCharCode(96).repeat(100000) + 'x$';
         if (n(input) !== input.slice(0, -1) + '\\\\$') process.exit(1);`,
      ],
      { timeout: 5000, stdio: "pipe" },
    );
  });

  it("renders nested list continuation math rather than treating it as code", () => {
    expect(n("- outer\n    - inner\n\n        \\(x\\)")).toBe(
      "- outer\n    - inner\n\n        $x$",
    );
  });

  it("preserves TeX line breaks in display blocks without blank lines", () => {
    const input =
      "before\n$$\n\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\n$$\nafter";
    expect(n(input)).toBe(input);
  });

  it("preserves unclosed fences through the end of the message", () => {
    const input = "~~~\n\\(x\\) $5\n\\[y\\]";
    expect(n(input)).toBe(input);
  });

  it("leaves ordinary prose byte-identical, including CRLF and Unicode", () => {
    const input =
      "**Newton’s law**\r\n\r\n- Force → acceleration.\r\n\t中文 😀\r\n";
    expect(n(input)).toBe(input);
  });
  it("leaves code inside list items untouched", () => {
    const tilde = "- step\n\n  ~~~\n  \\(x\\) $5\n  ~~~\n\n- then \\(y\\)";
    expect(n(tilde)).toBe("- step\n\n  ~~~\n  \\(x\\) $5\n  ~~~\n\n- then $y$");
    const indented = "1. step\n\n        \\(x\\) $5\n\n2. \\(y\\)";
    expect(n(indented)).toBe("1. step\n\n        \\(x\\) $5\n\n2. $y$");
  });

  it("preserves multi-line reference definitions", () => {
    const def = "[x]:\n  https://example.com/a\\(b\\)";
    expect(n(`[x] and \\(y\\)\n\n${def}`)).toBe(`[x] and $y$\n\n${def}`);
  });

  it("keeps image alt text and destinations literal", () => {
    const img = "![\\(x\\) $5](https://example.com/a\\(b\\).png)";
    expect(n(`${img} then \\(y\\)`)).toBe(`${img} then $y$`);
  });

  it("keeps escaped dollars inside math from closing the span", () => {
    expect(n("cost $a\\$b$ here")).toBe("cost $a{\\char36}b$ here");
  });

  it("leaves $$ blocks with blank lines intact", () => {
    const block = "$$\nx\n\ny\n$$";
    expect(n(`intro\n\n${block}\n\nthen \\(z\\)`)).toBe(
      `intro\n\n${block}\n\nthen $z$`,
    );
  });

  it("converts math in link labels and headings but not autolinks", () => {
    expect(n("## Force \\(F\\)")).toBe("## Force $F$");
    expect(n("[see \\(x\\)](https://e.com/\\(q\\))")).toBe(
      "[see $x$](https://e.com/\\(q\\))",
    );
    expect(n("see https://e.com/a, costs $5")).toBe(
      "see https://e.com/a, costs \\$5",
    );
    expect(n("<https://e.com/\\(q\\)> and \\(y\\)")).toBe(
      "<https://e.com/\\(q\\)> and $y$",
    );
  });

  it("never lets currency reach into inline code or link targets", () => {
    expect(n("Pay $5, then run `echo $10`.")).toBe(
      "Pay \\$5, then run `echo $10`.",
    );
    expect(n("Pay $5 at [shop](https://e.com/?p=$10) now")).toBe(
      "Pay \\$5 at [shop](https://e.com/?p=$10) now",
    );
  });

  it("keeps blockquote display math inside the quote", () => {
    expect(n("> \\[\n> x^2\n> \\]")).toBe("> $$\n> x^2\n> $$");
    expect(n("> Note:\n> \\[F=ma\\]")).toBe("> Note:\n> $$\n> F=ma\n> $$");
  });

  it("keeps list-item display math inside the item", () => {
    expect(n("- \\[F=ma\\]\n- next")).toBe("- $$\n  F=ma\n  $$\n- next");
    expect(n("1. Use\n   \\[a=b\\]")).toBe("1. Use\n   $$\n   a=b\n   $$");
  });

  it("keeps prose following a multiline display outside its closing fence", () => {
    expect(n("\\[\nF=ma\n\\],\nwhere m is mass.")).toBe(
      "$$\nF=ma\n$$\n,\nwhere m is mass.",
    );
    expect(n("> \\[\n> x^2\n> \\] to solve.")).toBe(
      "> $$\n> x^2\n> $$\n> to solve.",
    );
    expect(n("- \\[\n  x^2\n  \\].\n- Next")).toBe(
      "- $$\n  x^2\n  $$\n  .\n- Next",
    );
  });

  it("converts multiline math embedded in a sentence", () => {
    expect(n("Thus \\[\nx^2 + y^2\n= r^2\n\\] holds.")).toBe(
      "Thus $$x^2 + y^2 = r^2$$ holds.",
    );
    expect(n("> Thus \\[\n> F=ma\n> \\] holds.")).toBe(
      "> Thus $$F=ma$$ holds.",
    );
  });
});
