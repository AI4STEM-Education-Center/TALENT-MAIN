import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./math-delimiters";

describe("normalizeMathDelimiters", () => {
  it("rewrites inline \\( \\) to $ $", () => {
    expect(
      normalizeMathDelimiters(
        "In Newton's second law, \\(\\vec a=\\vec F_{\\text{net}}/m\\); so…",
      ),
    ).toBe("In Newton's second law, $\\vec a=\\vec F_{\\text{net}}/m$; so…");
  });

  it("rewrites display \\[ \\] to $$ $$, across lines", () => {
    expect(normalizeMathDelimiters("Use\n\\[\nF = ma\n\\]\nthen")).toBe(
      "Use\n$$F = ma$$\nthen",
    );
  });

  it("leaves dollar math and plain text alone", () => {
    const s = "Already $x^2$ and $$y$$, cost (about 5).";
    expect(normalizeMathDelimiters(s)).toBe(s);
  });

  it("does not touch inline code or fenced code", () => {
    const s = "Run `echo \\(x\\)` or\n```\n\\[ raw \\]\n```\nthen \\(y\\)";
    expect(normalizeMathDelimiters(s)).toBe(
      "Run `echo \\(x\\)` or\n```\n\\[ raw \\]\n```\nthen $y$",
    );
  });

  it("keeps an unterminated \\( as literal text", () => {
    expect(normalizeMathDelimiters("a \\(b")).toBe("a \\(b");
  });
});
