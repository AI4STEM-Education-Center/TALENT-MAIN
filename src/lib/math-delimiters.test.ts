import { describe, expect, it } from "vitest";
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
});
